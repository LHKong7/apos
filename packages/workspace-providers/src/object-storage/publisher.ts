import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { ChangeSet, PublishResult, Workspace } from '@apos/contracts';
import type { Diagnose, ObjectStoreDescriptor } from '../ports';
import type { Publisher, ReleaseContext } from '../publisher-types';
import { isSafeRelative, normalizePrefix, type ObjectStorageMaterializer } from './source';

/**
 * 对象存储交货后端。
 *
 * ★★ 只上传变更集里的对象，不整个目录重传。
 *
 *   这就是「保留 ChangeSet 概念」最直接的回报：一个 20GB 的数据集挂进来，
 *   Agent 改了 3 个文件 —— 传那 3 个。退化成「扫描目录全量上传」的话，
 *   每次收尾都是一次 20GB 的出网流量，而且大部分对象的内容根本没变。
 *
 * ★ 变更集不完整时**不上传**。照着一份不完整的清单传，得到的是一个
 *   看起来成功、实际缺对象的远端状态 —— 而缺了什么没有任何地方说得出来。
 */
export class ObjectStoragePublisher implements Publisher {
  readonly kind = 'object_storage' as const;

  constructor(
    private readonly source: ObjectStorageMaterializer,
    private readonly options: {
      /** 按挂载的寻址键回查端点描述 —— 交货时挂载点上只剩 identifier */
      resolveStore: (mount: { source: { identifier: string } }) => Promise<ObjectStoreDescriptor | null>;
      onDiagnostic?: Diagnose;
    },
  ) {}

  async publish(ws: Workspace, changes: ChangeSet, _ctx: ReleaseContext): Promise<PublishResult> {
    const primary = ws.mounts.find((m) => m.role === 'primary');
    const store = primary ? await this.options.resolveStore(primary) : null;

    if (!primary || !store) {
      return {
        kind: 'object_storage',
        bucket: store?.bucket ?? '',
        prefix: store?.prefix ?? '',
        uploaded: 0,
        removed: 0,
        url: null,
        persisted: false,
        note: '找不到对象存储端点，未上传',
      };
    }

    const prefix = normalizePrefix(store.prefix);
    const base = {
      kind: 'object_storage' as const,
      bucket: store.bucket,
      prefix,
      url: consoleUrl(store, prefix),
    };

    if (!primary.writable) {
      return {
        ...base,
        uploaded: 0,
        removed: 0,
        persisted: false,
        note: `${store.ref} 是只读挂载，${changes.total} 处改动未上传`,
      };
    }

    if (changes.truncated) {
      return {
        ...base,
        uploaded: 0,
        removed: 0,
        persisted: false,
        note: `变更集不完整（对象数超上限或基线丢失），未上传；产出仍在 ${primary.path}`,
      };
    }

    if (changes.total === 0) {
      return { ...base, uploaded: 0, removed: 0, persisted: true, note: '没有任何改动，无需上传' };
    }

    const client = this.source.clientFor(store);
    const failures: string[] = [];
    let uploaded = 0;
    let removed = 0;

    for (const rel of [...changes.added, ...changes.modified]) {
      if (!isSafeRelative(rel)) {
        failures.push(rel);
        continue;
      }
      try {
        const bytes = await readFile(join(primary.path, rel));
        await client.put(`${prefix}${rel}`, bytes, contentTypeOf(rel));
        uploaded++;
      } catch (err) {
        failures.push(rel);
        this.options.onDiagnostic?.(`上传 ${rel} 失败`, err);
      }
    }

    for (const rel of changes.deleted) {
      if (!isSafeRelative(rel)) continue;
      try {
        await client.delete(`${prefix}${rel}`);
        removed++;
      } catch (err) {
        failures.push(rel);
        this.options.onDiagnostic?.(`删除 ${rel} 失败`, err);
      }
    }

    /**
     * ★ 部分失败**不算已持久化**。半传上去的一批对象比完全没传更危险 ——
     *   远端处于一个既不是旧状态也不是新状态的中间态，而调用方看到
     *   persisted: true 就不会再管它了。
     */
    const persisted = failures.length === 0;
    const note = failures.length
      ? `上传 ${uploaded}、删除 ${removed}；${failures.length} 个失败：${failures.slice(0, 5).join('、')}（远端处于中间态，需人工核对）`
      : `已上传 ${uploaded} 个对象、删除 ${removed} 个，到 ${store.bucket}/${prefix}`;

    return { ...base, uploaded, removed, persisted, note };
  }
}

/**
 * 可点开的控制台地址。
 *
 * ★ 只对认得出的端点给链接。自建 MinIO / Ceph 的控制台路径千奇百怪，
 *   猜一个出来只会让人点到 404 —— 与 git 那边「认不出 host 就不给链接」
 *   是同一条纪律。
 */
function consoleUrl(store: ObjectStoreDescriptor, prefix: string): string | null {
  const host = safeHost(store.endpoint);
  if (!host) return null;
  if (host.endsWith('amazonaws.com')) {
    return `https://s3.console.aws.amazon.com/s3/buckets/${store.bucket}?prefix=${encodeURIComponent(prefix)}`;
  }
  return null;
}

function safeHost(endpoint: string): string | null {
  try {
    return new URL(endpoint).host.toLowerCase();
  } catch {
    return null;
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

function contentTypeOf(rel: string): string {
  return CONTENT_TYPES[extname(rel).toLowerCase()] ?? 'application/octet-stream';
}
