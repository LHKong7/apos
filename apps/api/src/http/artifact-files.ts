import { createReadStream } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { artifacts, type Database } from '@apos/db';
import { fail, notFound } from './errors';

/**
 * Artifact file gateway / 产物文件网关。
 *
 * ★★ The UI previously **could not open** a single file an agent had changed.
 *
 *   Local delivery recorded only an archivePath plus a change-set summary on
 *   the artifact row, so the artifacts page could say "12 files changed" and
 *   list every filename while opening none of them. Reading the content meant
 *   logging into the server.
 *
 *   本地交付只在 artifacts 上记了一个 archivePath 与变更集摘要，
 *   于是产物页能显示「改了 12 个文件」和文件名，却打不开任何一个。
 *
 * ★★ Never hand a server-local absolute path to the browser.
 *
 *   archivePath is a real path on the host. Returning it verbatim leaks the
 *   deployment layout and the workspace root, and it is useless to the caller
 *   anyway — a browser cannot read the host filesystem. Everything goes through
 *   artifactId + a relative path, and this layer does the resolution and the
 *   escape checks.
 *
 *   直接回给前端等于把部署结构、工作区根目录一并暴露出去，而且拿到它也没法读。
 *
 * ★ Only serves artifacts whose `storageKey` points at a local archive
 *   directory. The git and object-storage kinds already have their own
 *   clickable addresses (a PR link, a console link) and should not be routed
 *   through here a second time.
 *
 *   git / 对象存储那两类有自己的可点开地址，不该从这里再走一遍。
 */

/** Per-file preview cap. Anything larger is download-only, never inlined into JSON */
const MAX_PREVIEW_BYTES = 512 * 1024;
/** Directory listing cap — an archive of tens of thousands of files must not blow up the response */
const MAX_ENTRIES = 2000;

export interface ArtifactFileEntry {
  path: string;
  size: number;
  /** Directories get no preview; the UI uses this to decide what is clickable */
  isDirectory: boolean;
  /**
   * Whether this run added, modified, or deleted the file /
   * 这个文件在这次执行里是新增、修改还是删除。
   *
   * ★★ A bare list of filenames cannot separate "the agent wrote this file"
   *   from "the agent edited this file" — and a reviewer looks at those two
   *   completely differently. 只列文件名不说改动类型，用户分不清这两件事。
   *
   * ★ `deleted` files are **not in the archive** (it only copies added and
   *   modified content), but they still have to be listed: what a run deleted
   *   is the part of the change set that most needs to be seen.
   *   一次执行删掉了什么，是变更集里最该被看见的部分。
   */
  change: 'added' | 'modified' | 'deleted' | null;
}

/** The change set stored on the artifact metadata (written at ingest) */
interface StoredChangeSet {
  added?: string[];
  modified?: string[];
  deleted?: string[];
  listTruncated?: boolean;
}

function changeIndex(meta: Record<string, unknown>): {
  byPath: Map<string, 'added' | 'modified' | 'deleted'>;
  deleted: string[];
  truncated: boolean;
} {
  const cs = (meta['changes'] ?? {}) as StoredChangeSet;
  const byPath = new Map<string, 'added' | 'modified' | 'deleted'>();
  for (const p of cs.added ?? []) byPath.set(p, 'added');
  for (const p of cs.modified ?? []) byPath.set(p, 'modified');
  for (const p of cs.deleted ?? []) byPath.set(p, 'deleted');
  return { byPath, deleted: cs.deleted ?? [], truncated: cs.listTruncated === true };
}

async function loadLocalArtifact(db: Database, artifactId: string) {
  const [row] = await db.select().from(artifacts).where(eq(artifacts.id, artifactId));
  if (!row) throw notFound('artifact');

  const root = row.storageKey?.trim();
  if (!root) {
    throw fail(
      'VALIDATION_FAILED',
      'artifact.no_local_archive',
      '这个产物没有本地归档目录 —— git 与对象存储的产物请用它自己的链接打开',
      { details: { artifactId, storage: row.storage } },
    );
  }
  return { row, root: resolve(root) };
}

/**
 * Resolve symlinks in a path that **may not exist yet**: realpath the nearest
 * existing ancestor, then re-append the missing tail /
 * 解析到最近的存在祖先，剩下的段原样接回。
 *
 * ★★ This must not be written as `realpath(target).catch(() => target)`.
 *
 *   When target is missing, realpath throws ENOENT and the fallback is the
 *   **unresolved** path — while the root side resolved fine. Two paths in
 *   different coordinate systems, so relative() always starts with `..` and
 *   "file not found" gets reported as "path escapes the archive". On macOS
 *   both `tmpdir()` and `/tmp` lead to `/private/…`, so any archive root down
 *   there hits it every time; on Linux `/tmp` is a real directory, so the bug
 *   disappears when you move machines and is miserable to track down. The cost
 *   is not just awkward wording: that message accuses someone of pointing a
 *   symlink out of the archive, when the truth is the file is simply gone —
 *   and the next step differs completely between the two.
 *
 *   macOS 上必踩、Linux 上必不现，所以这个 bug 换台机器就消失，很难追。
 *
 * ★ It also gets missing files under a symlinked directory right:
 *   `root/link/nope.txt` used to be returned untouched and still looked like
 *   it was inside the archive; now `link` is resolved away and a real escape
 *   is still caught.
 */
async function realpathAllowingMissing(p: string): Promise<string> {
  const missing: string[] = [];
  let current = p;
  for (;;) {
    const real = await realpath(current).catch(() => null);
    if (real !== null) return missing.length > 0 ? join(real, ...missing) : real;
    const parent = dirname(current);
    // ★ Nothing resolved all the way up to the filesystem root (a missing drive letter,
    //   say): return it as-is and let the string-level check above decide.
    if (parent === current) return p;
    missing.unshift(basename(current));
    current = parent;
  }
}

/**
 * Resolve a caller-supplied relative path to an absolute one and refuse anything
 * that escapes the archive / 把用户给的相对路径解析成绝对路径，并挡住越界。
 *
 * ★★ This is the security core of the file.
 *
 *   Both `..` and absolute paths have to be refused, or
 *   `GET /artifacts/:id/files/../../etc/passwd` reads any file outside the
 *   archive directory. The boundary check is resolve + relative, not a string
 *   `startsWith` — the latter lets `/data/archive-evil` pass a `/data/archive`
 *   prefix test (the same discipline as isMountRootAllowed).
 *
 * ★ Symlinks need their own check: a symlink inside the archive pointing at
 *   /etc passes every path test while the content sits outside, so realpath
 *   verifies once more at the end.
 *   路径判定全过而内容越界，所以最后再用 realpath 复核一次。
 */
async function safeResolve(root: string, rel: string): Promise<string> {
  const target = resolve(root, rel);
  const within = relative(root, target);
  if (within === '' || within.startsWith('..') || within.startsWith(sep) || /^[a-zA-Z]:/.test(within)) {
    throw fail(
      'VALIDATION_FAILED',
      'artifact.path_escapes_root',
      '路径越界',
      { details: { path: rel } },
    );
  }

  const realRoot = await realpathAllowingMissing(root);
  const real = await realpathAllowingMissing(target);
  const realWithin = relative(realRoot, real);
  if (realWithin.startsWith('..') || realWithin.startsWith(sep)) {
    throw fail(
      'VALIDATION_FAILED',
      'artifact.path_escapes_via_symlink',
      '路径越界（符号链接指向归档目录之外）',
      { details: { path: rel } },
    );
  }
  return target;
}

/** List the files in the archive. Paths are relative; the UI uses them to request one file */
export async function listArtifactFiles(db: Database, artifactId: string) {
  const { row, root } = await loadLocalArtifact(db, artifactId);

  const changes = changeIndex(row.metadata);
  const out: ArtifactFileEntry[] = [];
  let truncated = false;

  async function walk(dir: string) {
    if (out.length >= MAX_ENTRIES) {
      truncated = true;
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (out.length >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const full = join(dir, e.name);
      const rel = relative(root, full);
      if (e.isDirectory()) {
        out.push({ path: rel, size: 0, isDirectory: true, change: null });
        await walk(full);
      } else if (e.isFile()) {
        const st = await stat(full).catch(() => null);
        out.push({
          path: rel,
          size: st?.size ?? 0,
          isDirectory: false,
          change: changes.byPath.get(rel) ?? null,
        });
      }
      // ★ Symlinks are neither listed nor followed — an archive should not contain any,
      //   and one that shows up should not be treated as content either.
    }
  }

  const exists = await stat(root).catch(() => null);
  if (!exists) {
    /**
     * ★ Say the directory is gone rather than returning an empty list.
     *   An empty list reads as "this run produced nothing", when the truth is
     *   the output was reclaimed — and the next step differs completely.
     *   两者的下一步动作完全不同。
     */
    return {
      artifactId,
      projectId: row.projectId,
      available: false as const,
      /** ★ The code is for the UI, the sentence for logs and fallback. See error-reason.ts */
      reasonCode: 'archive_gone' as const,
      reason: '归档目录已不存在（可能随工作区一起被回收了）',
      files: [],
      truncated: false,
      diffAvailable: false as const,
    };
  }

  await walk(root);

  /**
   * ★★ Deleted files have to be appended to the listing.
   *
   *   The archive holds only added and modified content (that is all
   *   LocalPublisher copies), so walking the directory can never reach them.
   *   Yet "which files this run deleted" is exactly the part of the change set
   *   that most needs to be seen — leave it out and the artifacts page reads
   *   as if the run had only ever added things.
   *
   *   漏掉它，产物页会让人以为这次只是加了东西。
   */
  for (const path of changes.deleted) {
    if (!out.some((f) => f.path === path)) {
      out.push({ path, size: 0, isDirectory: false, change: 'deleted' });
    }
  }

  return {
    artifactId,
    projectId: row.projectId,
    available: true as const,
    reasonCode: null,
    reason: null,
    files: out.sort((a, b) => a.path.localeCompare(b.path)),
    truncated: truncated || changes.truncated,
    /**
     * ★ Be explicit about why there is no before/after view: the local archive
     *   stores only the post-change content, the earlier version was never
     *   kept. A one-sided "diff" misleads more than offering none at all.
     */
    diffAvailable: false as const,
  };
}

/** One file's content. Text gets a preview; binary and oversized files get metadata only */
export async function readArtifactFile(db: Database, artifactId: string, rel: string) {
  const { row, root } = await loadLocalArtifact(db, artifactId);
  const full = await safeResolve(root, rel);

  const st = await stat(full).catch(() => null);
  if (!st || !st.isFile()) throw notFound('file');

  const mime = mimeOf(rel);
  const binary = !isTextual(rel, mime);

  if (binary || st.size > MAX_PREVIEW_BYTES) {
    return {
      artifactId,
      projectId: row.projectId,
      path: rel,
      size: st.size,
      mime,
      /** ★ When no content is returned, say why and point at the download */
      preview: null,
      reasonCode: binary ? ('binary' as const) : ('too_large' as const),
      reasonParams: binary ? undefined : { kb: MAX_PREVIEW_BYTES / 1024 },
      reason: binary ? '二进制文件，用下载打开' : `文件超过 ${MAX_PREVIEW_BYTES / 1024}KB，用下载打开`,
    };
  }

  return {
    artifactId,
    projectId: row.projectId,
    path: rel,
    size: st.size,
    mime,
    preview: await readFile(full, 'utf8'),
    reasonCode: null,
    reason: null,
  };
}

/** Download one file. Returns the stream plus metadata; the route layer sets the headers */
export async function openArtifactFile(db: Database, artifactId: string, rel: string) {
  const { root } = await loadLocalArtifact(db, artifactId);
  const full = await safeResolve(root, rel);
  const st = await stat(full).catch(() => null);
  if (!st || !st.isFile()) throw notFound('file');

  return { stream: createReadStream(full), size: st.size, mime: mimeOf(rel), name: rel.split('/').pop() ?? 'file' };
}

const TEXT_EXT = new Set([
  '.txt', '.md', '.json', '.yaml', '.yml', '.toml', '.ini', '.csv', '.tsv',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php',
  '.sh', '.bash', '.zsh', '.sql', '.html', '.css', '.scss', '.less', '.xml',
  '.svg', '.diff', '.patch', '.log', '.env', '.gitignore', '.dockerfile',
]);

const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

function mimeOf(rel: string): string {
  const ext = extname(rel).toLowerCase();
  return MIME[ext] ?? (TEXT_EXT.has(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
}

function isTextual(rel: string, mime: string): boolean {
  const ext = extname(rel).toLowerCase();
  // ★ Extension-less files (Makefile, Dockerfile) are treated as text — they almost always are
  if (ext === '') return true;
  return TEXT_EXT.has(ext) || mime.startsWith('text/') || mime === 'application/json';
}
