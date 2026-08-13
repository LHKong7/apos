import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { artifacts, type Database } from '@apos/db';
import { ApiError, notFound } from './errors';

/**
 * 产物文件网关。
 *
 * ★★ 页面此前**看不到** Agent 改出来的文件。
 *
 *   本地交付只在 artifacts 上记了一个 archivePath 与变更集摘要，
 *   于是产物页能显示「改了 12 个文件」和文件名，却打不开任何一个。
 *   用户要看内容只能上服务器。
 *
 * ★★ 绝不把服务器本地绝对路径交给浏览器。
 *
 *   archivePath 是宿主机上的真实路径。直接回给前端等于把部署结构、
 *   工作区根目录一并暴露出去，而且拿到它也没法读 —— 浏览器又访问不了。
 *   所以一律走 artifactId + 相对路径，由这一层做解析与越界防护。
 *
 * ★ 只服务 `storageKey` 指向本地归档目录的那类产物。git / 对象存储那两类
 *   有自己的可点开地址（PR 链接、控制台链接），不该从这里再走一遍。
 */

/** 单文件预览上限。超过就只给下载，不塞进 JSON */
const MAX_PREVIEW_BYTES = 512 * 1024;
/** 目录列举上限 —— 一次归档几万个文件时别把响应撑爆 */
const MAX_ENTRIES = 2000;

export interface ArtifactFileEntry {
  path: string;
  size: number;
  /** 目录不给 preview，前端据此决定能不能点开 */
  isDirectory: boolean;
  /**
   * 这个文件在这次执行里是新增、修改还是删除。
   *
   * ★★ 只列文件名不说改动类型，用户分不清「Agent 新写了这个文件」和
   *   「Agent 改了这个文件」—— 而这两件事在 review 时的看法完全不同。
   *
   * ★ `deleted` 的文件**不在归档里**（归档只复制新增与修改的内容），
   *   但必须列出来：一次执行删掉了什么，是变更集里最该被看见的部分。
   */
  change: 'added' | 'modified' | 'deleted' | null;
}

/** 产物元数据里存下来的变更集（ingest 写的） */
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
  if (!row) throw notFound('产物');

  const root = row.storageKey?.trim();
  if (!root) {
    throw new ApiError(
      'VALIDATION_FAILED',
      '这个产物没有本地归档目录 —— git 与对象存储的产物请用它自己的链接打开',
      { artifactId, storage: row.storage },
    );
  }
  return { row, root: resolve(root) };
}

/**
 * 把用户给的相对路径解析成绝对路径，并挡住越界。
 *
 * ★★ 这是本文件的安全核心。
 *
 *   `..` 与绝对路径都必须挡下来，否则 `GET /artifacts/:id/files/../../etc/passwd`
 *   就能读到归档目录以外的任何文件。用 resolve + relative 判边界，
 *   而不是字符串 startsWith —— 后者会让 `/data/archive-evil` 通过
 *   `/data/archive` 这条前缀检查（与 isMountRootAllowed 同一条纪律）。
 *
 * ★ 符号链接也要挡：归档目录里的一条 symlink 指向 /etc 的话，
 *   路径判定全过而内容越界。所以最后再用 realpath 复核一次。
 */
async function safeResolve(root: string, rel: string): Promise<string> {
  const target = resolve(root, rel);
  const within = relative(root, target);
  if (within === '' || within.startsWith('..') || within.startsWith(sep) || /^[a-zA-Z]:/.test(within)) {
    throw new ApiError('VALIDATION_FAILED', '路径越界', { path: rel });
  }

  const { realpath } = await import('node:fs/promises');
  const realRoot = await realpath(root).catch(() => root);
  const real = await realpath(target).catch(() => target);
  const realWithin = relative(realRoot, real);
  if (realWithin.startsWith('..') || realWithin.startsWith(sep)) {
    throw new ApiError('VALIDATION_FAILED', '路径越界（符号链接指向归档目录之外）', { path: rel });
  }
  return target;
}

/** 列出归档里的文件。相对路径，前端拿它去请求单个文件 */
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
      // ★ symlink 既不列也不跟进 —— 归档里不该有，出现了也不该被当成内容
    }
  }

  const exists = await stat(root).catch(() => null);
  if (!exists) {
    /**
     * ★ 目录没了要如实说，而不是回一个空列表。
     *   空列表读起来像「这次没产出」，而真相是产出被清理掉了 ——
     *   两者的下一步动作完全不同。
     */
    return {
      artifactId,
      projectId: row.projectId,
      available: false as const,
      reason: '归档目录已不存在（可能随工作区一起被回收了）',
      files: [],
      truncated: false,
      diffAvailable: false as const,
    };
  }

  await walk(root);

  /**
   * ★★ 被删掉的文件要补进列表。
   *
   *   归档里只有新增与修改的内容（LocalPublisher 就是这么复制的），
   *   所以走目录永远走不到它们。而「这次执行删了哪几个文件」恰恰是变更集里
   *   最该被看见的部分 —— 漏掉它，产物页会让人以为这次只是加了东西。
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
    reason: null,
    files: out.sort((a, b) => a.path.localeCompare(b.path)),
    truncated: truncated || changes.truncated,
    /**
     * ★ 如实说明为什么没有 before/after 对照：本地归档只存改完之后的内容，
     *   变更前的版本没有留。给一个只有一侧的「diff」比不给更容易误导。
     */
    diffAvailable: false as const,
  };
}

/** 单个文件的内容。文本给预览，二进制与超大文件只报元信息 */
export async function readArtifactFile(db: Database, artifactId: string, rel: string) {
  const { row, root } = await loadLocalArtifact(db, artifactId);
  const full = await safeResolve(root, rel);

  const st = await stat(full).catch(() => null);
  if (!st || !st.isFile()) throw notFound('文件');

  const mime = mimeOf(rel);
  const binary = !isTextual(rel, mime);

  if (binary || st.size > MAX_PREVIEW_BYTES) {
    return {
      artifactId,
      projectId: row.projectId,
      path: rel,
      size: st.size,
      mime,
      /** ★ 不给内容时要说清楚为什么，并指向下载 */
      preview: null,
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
    reason: null,
  };
}

/** 下载单个文件。返回流与元信息，由路由层设响应头 */
export async function openArtifactFile(db: Database, artifactId: string, rel: string) {
  const { root } = await loadLocalArtifact(db, artifactId);
  const full = await safeResolve(root, rel);
  const st = await stat(full).catch(() => null);
  if (!st || !st.isFile()) throw notFound('文件');

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
  // ★ 没有扩展名的（Makefile、Dockerfile）按文本处理 —— 它们几乎总是文本
  if (ext === '') return true;
  return TEXT_EXT.has(ext) || mime.startsWith('text/') || mime === 'application/json';
}
