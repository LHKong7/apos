import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChangeSet, Mount } from '@apos/contracts';
import {
  compareSnapshots,
  dropSnapshot,
  loadSnapshot,
  saveSnapshot,
  snapshotDir,
  snapshotFromEntries,
  stateKey,
  UNKNOWN_CHANGES,
} from '../snapshot';
import type { Diagnose, ObjectStoreDescriptor, SecretResolver } from '../ports';
import type { MountSpec, SourceMaterializer } from '../types';
import { S3Client, S3Error, type S3ClientOptions } from './s3';

export class ObjectStoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectStoreConfigError';
  }
}

export interface ObjectStorageDeps {
  root: string;
  secrets: SecretResolver;
  /** 注入 fetch / 时钟，测试用 */
  clientFactory?: (opts: S3ClientOptions) => S3Client;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  onDiagnostic?: Diagnose;
}

/**
 * 对象存储铺料后端（S3 兼容）。
 *
 * ★★ Agent 拿到的仍然是一个**本地目录** —— 这是整套抽象的前提：
 *   headless CLI 要 `cd` 进去再 `open()`，没有哪个 CLI 会说 S3 协议。
 *   所以这里干的是「同步下来」，而不是「让 Agent 直接读 bucket」。
 *
 * ★ 基线是 ETag 清单，不是本地文件的 size:mtime。
 *
 *   下载下来的文件 mtime 是「下载那一刻」，跟内容毫无关系；用它当基线的话
 *   两次下载同一个对象都会算成「修改」。ETag 是服务端给的内容标识，
 *   这才是能跨端比较的东西。
 *
 * ★ diff 时**不再调 API**：Agent 改的是本地文件，所以拿本地扫描结果和
 *   下载时记下的本地指纹比。远端在这期间可能也变了，但那是另一个问题
 *   （并发写冲突），不该混进「Agent 改了什么」这个问题里。
 */
export class ObjectStorageMaterializer implements SourceMaterializer {
  readonly kind = 'object_storage' as const;

  constructor(private readonly deps: ObjectStorageDeps) {}

  clientFor(store: ObjectStoreDescriptor): S3Client {
    const raw = this.deps.secrets.resolve(store.credentialRef);
    if (!raw) {
      throw new ObjectStoreConfigError(
        `对象存储 ${store.ref} 没有可用的凭证（credentialRef 解不出明文）`,
      );
    }
    const sep = raw.indexOf(':');
    if (sep <= 0) {
      throw new ObjectStoreConfigError(
        `对象存储 ${store.ref} 的凭证格式应为 accessKeyId:secretAccessKey`,
      );
    }

    const opts: S3ClientOptions = {
      endpoint: store.endpoint,
      region: store.region,
      bucket: store.bucket,
      forcePathStyle: store.forcePathStyle,
      credentials: {
        accessKeyId: raw.slice(0, sep),
        secretAccessKey: raw.slice(sep + 1),
      },
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
    };
    return this.deps.clientFactory ? this.deps.clientFactory(opts) : new S3Client(opts);
  }

  async materialize(spec: MountSpec): Promise<Mount> {
    const store = spec.store;
    if (!store) throw new ObjectStoreConfigError('object_storage 挂载缺少端点信息');

    const client = this.clientFor(store);
    const prefix = normalizePrefix(store.prefix);

    const listed = await client.list(prefix);
    if (listed.truncated) {
      this.deps.onDiagnostic?.(
        `${store.bucket}/${prefix} 下的对象数超过上限，基线不完整`,
      );
    }

    await mkdir(spec.path, { recursive: true });

    /** 远端键 → 本地相对路径。ETag 清单同时按本地相对路径记 */
    const remoteEtags: Record<string, string> = {};
    let downloaded = 0;

    for (const obj of listed.objects) {
      // 「目录占位对象」（以 / 结尾、大小为 0）不是文件，跳过
      if (obj.key.endsWith('/')) continue;
      const rel = relativeKey(obj.key, prefix);
      if (!rel || !isSafeRelative(rel)) {
        this.deps.onDiagnostic?.(`跳过越界的对象键：${obj.key}`);
        continue;
      }
      const dest = join(spec.path, rel);
      try {
        const bytes = await client.get(obj.key);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, bytes);
        remoteEtags[rel] = obj.etag;
        downloaded++;
      } catch (err) {
        // 单个对象拉不下来不该拖垮整次派发，但基线里也不能有它 ——
        // 否则收尾时它会被算成「Agent 删掉的」
        this.deps.onDiagnostic?.(`对象 ${obj.key} 下载失败，已从基线中排除`, err);
      }
    }

    // ★ 平台自己的输入文件要在记基线**之前**放好
    await spec.seed?.(spec.path);

    const key = stateKey(spec.workspaceId ?? spec.path, spec.path);
    /**
     * ★ 落两份基线：
     *   - 本地指纹（size:mtime）用来算「Agent 改了什么」
     *   - 远端 ETag 清单用来在交货时判断「哪些对象真的需要重传」
     */
    const local = await snapshotDir(spec.path);
    await saveSnapshot(this.deps.root, key, local);
    await saveSnapshot(this.deps.root, `${key}-remote`, snapshotFromEntries(remoteEtags, listed.truncated));

    this.deps.onDiagnostic?.(
      `${store.bucket}/${prefix} 同步了 ${downloaded} 个对象到 ${spec.path}`,
    );

    return {
      path: spec.path,
      role: spec.role,
      writable: spec.writable,
      source: {
        kind: 'object_storage',
        identifier: key,
        label: `${store.bucket}/${prefix}`,
        baseVersion: local.hash,
      },
    };
  }

  async diff(mount: Mount): Promise<ChangeSet> {
    const before = await loadSnapshot(this.deps.root, mount.source.identifier);
    if (!before) {
      this.deps.onDiagnostic?.(`挂载 ${mount.path} 的基线快照丢失，变更集不可用`);
      return UNKNOWN_CHANGES;
    }
    const after = await snapshotDir(mount.path);
    return compareSnapshots(before, after);
  }

  async dispose(mount: Mount, opts: { keep?: boolean } = {}): Promise<void> {
    await dropSnapshot(this.deps.root, mount.source.identifier);
    await dropSnapshot(this.deps.root, `${mount.source.identifier}-remote`);
    if (!opts.keep) {
      await rm(mount.path, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** 交货方要用的远端 ETag 清单 */
  async remoteEtags(mount: Mount): Promise<Record<string, string> | null> {
    const snap = await loadSnapshot(this.deps.root, `${mount.source.identifier}-remote`);
    return snap?.files ?? null;
  }
}

/** `a/b/` —— 空前缀保持空，非空前缀补上结尾斜杠 */
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}

/** 远端键 → 相对本地路径 */
export function relativeKey(key: string, prefix: string): string | null {
  if (!prefix) return key;
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

/** 相对且不越界 —— 对象键由外部控制，`../` 能写到工作区之外 */
export function isSafeRelative(rel: string): boolean {
  if (rel === '' || rel.startsWith('/')) return false;
  return !rel.split('/').some((seg) => seg === '..' || seg === '.');
}

export { S3Error };
