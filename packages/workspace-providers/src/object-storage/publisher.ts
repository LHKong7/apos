import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { ChangeSet, PublishResult, Workspace } from '@apos/contracts';
import type { Diagnose, ObjectStoreDescriptor } from '../ports';
import type { Publisher, ReleaseContext } from '../publisher-types';
import { isSafeRelative, normalizePrefix, type ObjectStorageMaterializer } from './source';

/**
 * 交货语义。
 *
 * ★★ 这两种**必须**在类型上分开，否则会删错东西。
 *
 *   `sync`：目标就是主挂载的来源 —— 把工作区同步回原处。变更集里
 *           deleted 的那些对象要在远端一并删掉，否则远端反映的是
 *           「历次叠加」而不是收尾时的状态。
 *
 *   `deliver`：目标是**另一个** bucket（主挂载可能是 git）。这时
 *           `changes.deleted` 里的路径与目标 bucket 里的 key 毫无关系 ——
 *           照着删就是拿一次 Run 的变更集去删一个不相干的 bucket。
 *           所以只上传、不删除，而且落在 `{prefix}{runId}/` 下，
 *           不与别的 Run 互相覆盖。
 */
export type PublishMode = 'sync' | 'deliver';

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
      /**
       * 回查端点描述。
       *
       * ★ sync 语义下按挂载的寻址键回查（交货时挂载点上只剩 identifier）；
       *   deliver 语义下调用方直接给出目标，与挂载无关。
       */
      resolveStore: (mount: { source: { identifier: string } }) => Promise<ObjectStoreDescriptor | null>;
      /** 默认 sync —— 老行为 */
      mode?: PublishMode;
      onDiagnostic?: Diagnose;
    },
  ) {}

  private get mode(): PublishMode {
    return this.options.mode ?? 'sync';
  }

  async publish(ws: Workspace, changes: ChangeSet, ctx: ReleaseContext): Promise<PublishResult> {
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

    const deliver = this.mode === 'deliver';
    /**
     * ★ 投递时按 Run 分目录。不分的话，两次 Run 改了同一个相对路径
     *   （`report.md` 这种再常见不过的名字）后一次会静默覆盖前一次，
     *   而产物页上两条记录都指向同一个 key。
     */
    const prefix = deliver
      ? `${normalizePrefix(store.prefix)}${ctx.runId}/`
      : normalizePrefix(store.prefix);
    const base = {
      kind: 'object_storage' as const,
      bucket: store.bucket,
      prefix,
      url: consoleUrl(store, prefix),
    };

    /**
     * ★ 只在 sync 语义下看挂载的可写性。deliver 语义下主挂载可能是一棵
     *   只读的 git 工作树，而那与「能不能往目标 bucket 写」毫无关系 ——
     *   目标自己的可写性由调用方在挑交货后端时就判过了。
     */
    if (!deliver && !primary.writable) {
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

    /**
     * ★★ 只有 sync 语义才删远端对象。
     *
     *   deliver 语义下 changes.deleted 里的路径说的是「Agent 在**工作区里**
     *   删了这些文件」，而目标 bucket 是另一个地方 —— 那里同名的 key
     *   （如果存在）属于别人。拿一次 Run 的变更集去删一个不相干的 bucket，
     *   是这次改动里唯一可能造成**数据丢失**的操作，所以它被关在这个分支后面。
     */
    if (!deliver) {
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
    }

    /**
     * ★ 部分失败**不算已持久化**。半传上去的一批对象比完全没传更危险 ——
     *   远端处于一个既不是旧状态也不是新状态的中间态，而调用方看到
     *   persisted: true 就不会再管它了。
     */
    const persisted = failures.length === 0;
    const where = `${store.bucket}/${prefix}`;
    const note = failures.length
      ? `上传 ${uploaded}、删除 ${removed}；${failures.length} 个失败：${failures.slice(0, 5).join('、')}（远端处于中间态，需人工核对）`
      : deliver
        ? `已投递 ${uploaded} 个文件到 ${where}（投递不删除目标里的任何对象）`
        : `已上传 ${uploaded} 个对象、删除 ${removed} 个，到 ${where}`;

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
