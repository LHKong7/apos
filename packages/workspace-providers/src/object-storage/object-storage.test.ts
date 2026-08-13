import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Mount } from '@apos/contracts';
import { ObjectStorageMaterializer, ObjectStoreConfigError, normalizePrefix, relativeKey } from './source';
import { ObjectStoragePublisher } from './publisher';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'apos-oss-'));
});

const STORE = {
  id: 's1',
  ref: 'reports',
  endpoint: 'https://minio.internal:9000',
  region: 'us-east-1',
  bucket: 'artifacts',
  prefix: 'runs/',
  forcePathStyle: true,
  credentialRef: 'secret://env/OSS_KEY',
};

/** 进程内假 bucket —— 一个 key → 内容的 Map，按 S3 的响应形状回话 */
function fakeBucket(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const writes: { method: string; key: string; body?: string }[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    // path-style：/artifacts/<key>
    const key = decodeURIComponent(url.pathname.replace(/^\/artifacts\/?/, ''));

    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const items = [...store.entries()].filter(([k]) => k.startsWith(prefix));
      return new Response(
        `<ListBucketResult><IsTruncated>false</IsTruncated>${items
          .map(
            ([k, v]) =>
              `<Contents><Key>${k}</Key><ETag>&quot;etag-${v.length}&quot;</ETag>` +
              `<Size>${v.length}</Size><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>`,
          )
          .join('')}</ListBucketResult>`,
      );
    }
    if (method === 'GET') {
      const v = store.get(key);
      return v === undefined
        ? new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
        : new Response(v);
    }
    if (method === 'PUT') {
      const body = init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : '';
      store.set(key, body);
      writes.push({ method, key, body });
      return new Response('', { status: 200 });
    }
    if (method === 'DELETE') {
      store.delete(key);
      writes.push({ method, key });
      return new Response(null, { status: 204 });
    }
    return new Response('', { status: 405 });
  };

  return { fetchImpl, store, writes };
}

function materializer(fetchImpl: typeof fetch) {
  return new ObjectStorageMaterializer({
    root,
    secrets: { resolve: () => 'AKID:SECRET' },
    fetchImpl,
    now: () => new Date('2026-01-01T00:00:00Z'),
  });
}

describe('前缀与键的换算', () => {
  it('前缀归一到带尾斜杠；空前缀保持空', () => {
    expect(normalizePrefix('runs')).toBe('runs/');
    expect(normalizePrefix('/runs/')).toBe('runs/');
    expect(normalizePrefix('')).toBe('');
  });

  it('远端键剥掉前缀得到本地相对路径', () => {
    expect(relativeKey('runs/a/b.txt', 'runs/')).toBe('a/b.txt');
    expect(relativeKey('other/a.txt', 'runs/')).toBeNull();
    expect(relativeKey('a.txt', '')).toBe('a.txt');
  });
});

describe('对象存储铺料', () => {
  /**
   * ★★ Agent 拿到的仍然是一个本地目录 —— headless CLI 不会说 S3 协议。
   *   所以这里干的是「同步下来」，不是「让 Agent 直接读 bucket」。
   */
  it('把 prefix 下的对象同步成本地目录树', async () => {
    const { fetchImpl } = fakeBucket({
      'runs/input.csv': 'a,b\n',
      'runs/nested/note.md': '# n\n',
      'other/ignored.txt': 'no',
    });
    const m = materializer(fetchImpl);
    const target = join(root, 'runs', 'r1', 'reports');

    const mount = await m.materialize({ role: 'primary', writable: true, path: target, store: STORE, workspaceId: 'r1' });

    expect(await readFile(join(target, 'input.csv'), 'utf8')).toBe('a,b\n');
    expect(await readFile(join(target, 'nested', 'note.md'), 'utf8')).toBe('# n\n');
    // 前缀之外的对象不该被拉下来
    await expect(readFile(join(target, 'ignored.txt'), 'utf8')).rejects.toThrow();

    expect(mount.source.kind).toBe('object_storage');
    expect(mount.source.label).toBe('artifacts/runs/');
    expect(mount.source.baseVersion).toBeTruthy();
  });

  /**
   * ★★ 基线是 ETag 清单而不是本地 mtime：下载下来的文件 mtime 是「下载那一刻」，
   *   跟内容毫无关系。不过 diff 比的是本地指纹 —— 关键是**同步完立刻记基线**，
   *   于是「刚同步下来、Agent 还没动」的状态下变更集必须是空的。
   */
  it('刚同步完、Agent 还没动时，变更集是空的', async () => {
    const { fetchImpl } = fakeBucket({ 'runs/a.txt': 'A', 'runs/b.txt': 'B' });
    const m = materializer(fetchImpl);
    const target = join(root, 'runs', 'r2', 'reports');
    const mount = await m.materialize({ role: 'primary', writable: true, path: target, store: STORE, workspaceId: 'r2' });

    const changes = await m.diff(mount);
    expect(changes.total).toBe(0);
  });

  it('变更集只报 Agent 动过的对象', async () => {
    const { fetchImpl } = fakeBucket({ 'runs/a.txt': 'A' });
    const m = materializer(fetchImpl);
    const target = join(root, 'runs', 'r3', 'reports');
    const mount = await m.materialize({ role: 'primary', writable: true, path: target, store: STORE, workspaceId: 'r3' });

    await new Promise((r) => setTimeout(r, 5));
    await writeFile(join(target, 'report.md'), '# out\n');
    await writeFile(join(target, 'a.txt'), 'A-changed');

    const changes = await m.diff(mount);
    expect(changes.added).toEqual(['report.md']);
    expect(changes.modified).toEqual(['a.txt']);
  });

  /** ★ 对象键由外部控制，`../` 能写到工作区之外 */
  it('越界的对象键被跳过，不写到工作区之外', async () => {
    const { fetchImpl } = fakeBucket({ 'runs/../escape.txt': 'bad', 'runs/ok.txt': 'good' });
    const m = materializer(fetchImpl);
    const target = join(root, 'runs', 'r4', 'reports');
    await m.materialize({ role: 'primary', writable: true, path: target, store: STORE, workspaceId: 'r4' });

    expect(await readFile(join(target, 'ok.txt'), 'utf8')).toBe('good');
    await expect(readFile(join(root, 'runs', 'r4', 'escape.txt'), 'utf8')).rejects.toThrow();
  });

  it('凭证解不出来时报可行动的错，而不是拿空 key 去签名换一个 403', async () => {
    const { fetchImpl } = fakeBucket();
    const m = new ObjectStorageMaterializer({ root, secrets: { resolve: () => null }, fetchImpl });
    await expect(
      m.materialize({ role: 'primary', writable: true, path: join(root, 'x'), store: STORE, workspaceId: 'r5' }),
    ).rejects.toThrow(ObjectStoreConfigError);
  });

  it('凭证格式不对时同样明说', async () => {
    const { fetchImpl } = fakeBucket();
    const m = new ObjectStorageMaterializer({ root, secrets: { resolve: () => 'only-one-part' }, fetchImpl });
    await expect(
      m.materialize({ role: 'primary', writable: true, path: join(root, 'x'), store: STORE, workspaceId: 'r6' }),
    ).rejects.toThrow(/accessKeyId:secretAccessKey/);
  });
});

describe('对象存储交货', () => {
  const ctx = { runId: 'run-1', outcome: 'completed' as const, summary: 's', agentName: 'a', goal: 'g' };

  function wsFor(path: string, writable = true): import('@apos/contracts').Workspace {
    const mount: Mount = {
      path,
      role: 'primary',
      writable,
      source: { kind: 'object_storage', identifier: 'k1', label: 'artifacts/runs/', baseVersion: 'v' },
    };
    return { id: 'w', runId: 'run-1', root: path, mounts: [mount], writable };
  }

  /**
   * ★★ 只上传变更集里的对象。退化成「全量上传」的话，一个 20GB 的数据集
   *   每次收尾都是一次 20GB 的出网流量，而大部分对象根本没变。
   */
  it('只上传增改、只删除删掉的，不整个目录重传', async () => {
    const { fetchImpl, writes, store } = fakeBucket({ 'runs/keep.txt': 'K', 'runs/gone.txt': 'G' });
    const m = materializer(fetchImpl);
    const path = join(root, 'runs', 'p1', 'reports');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'new.md'), '# new');
    await writeFile(join(path, 'keep.txt'), 'K2');

    const publisher = new ObjectStoragePublisher(m, { resolveStore: async () => STORE });
    const result = await publisher.publish(
      wsFor(path),
      { added: ['new.md'], modified: ['keep.txt'], deleted: ['gone.txt'], total: 3, truncated: false },
      ctx,
    );

    expect(result.kind).toBe('object_storage');
    if (result.kind !== 'object_storage') return;
    expect(result.uploaded).toBe(2);
    expect(result.removed).toBe(1);
    expect(result.persisted).toBe(true);

    expect(writes.map((w) => `${w.method} ${w.key}`).sort()).toEqual([
      'DELETE runs/gone.txt',
      'PUT runs/keep.txt',
      'PUT runs/new.md',
    ]);
    expect(store.get('runs/new.md')).toBe('# new');
  });

  it('只读挂载不写回，如实说明有多少改动被丢下', async () => {
    const { fetchImpl, writes } = fakeBucket();
    const m = materializer(fetchImpl);
    const path = join(root, 'runs', 'p2', 'reports');
    await mkdir(path, { recursive: true });

    const result = await new ObjectStoragePublisher(m, { resolveStore: async () => STORE }).publish(
      wsFor(path, false),
      { added: ['x.md'], modified: [], deleted: [], total: 1, truncated: false },
      ctx,
    );

    if (result.kind !== 'object_storage') return;
    expect(result.persisted).toBe(false);
    expect(result.note).toContain('只读挂载');
    expect(writes).toHaveLength(0);
  });

  it('变更集不完整时不上传', async () => {
    const { fetchImpl, writes } = fakeBucket();
    const m = materializer(fetchImpl);
    const path = join(root, 'runs', 'p3', 'reports');
    await mkdir(path, { recursive: true });

    const result = await new ObjectStoragePublisher(m, { resolveStore: async () => STORE }).publish(
      wsFor(path),
      { added: [], modified: [], deleted: [], total: 0, truncated: true },
      ctx,
    );

    if (result.kind !== 'object_storage') return;
    expect(result.persisted).toBe(false);
    expect(result.note).toContain('变更集不完整');
    expect(writes).toHaveLength(0);
  });

  /**
   * ★★ 半传上去的一批对象比完全没传更危险：远端处于既不是旧状态也不是
   *   新状态的中间态，而调用方看到 persisted: true 就不会再管它了。
   */
  it('部分失败时不报已持久化，并指出远端处于中间态', async () => {
    const { fetchImpl } = fakeBucket();
    const failing: typeof fetch = async (input, init) => {
      if ((init?.method ?? 'GET') === 'PUT' && String(input).includes('bad.md')) {
        return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
      }
      return fetchImpl(input, init);
    };
    const m = materializer(failing);
    const path = join(root, 'runs', 'p4', 'reports');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'ok.md'), 'ok');
    await writeFile(join(path, 'bad.md'), 'bad');

    const result = await new ObjectStoragePublisher(m, { resolveStore: async () => STORE }).publish(
      wsFor(path),
      { added: ['ok.md', 'bad.md'], modified: [], deleted: [], total: 2, truncated: false },
      ctx,
    );

    if (result.kind !== 'object_storage') return;
    expect(result.uploaded).toBe(1);
    expect(result.persisted).toBe(false);
    expect(result.note).toContain('中间态');
  });

  /** ★ 自建端点的控制台路径千奇百怪，猜一个只会让人点到 404 */
  it('认不出的端点不给控制台链接', async () => {
    const { fetchImpl } = fakeBucket();
    const m = materializer(fetchImpl);
    const path = join(root, 'runs', 'p5', 'reports');
    await mkdir(path, { recursive: true });

    const result = await new ObjectStoragePublisher(m, { resolveStore: async () => STORE }).publish(
      wsFor(path),
      { added: [], modified: [], deleted: [], total: 0, truncated: false },
      ctx,
    );
    if (result.kind !== 'object_storage') return;
    expect(result.url).toBeNull();
  });

  /**
   * ★★ deliver 语义：目标是**另一个** bucket，主挂载可能是一棵 git 工作树。
   *
   *   这几条断言各自挡住一种真实的破坏：
   *   - 不删除 —— changes.deleted 里的路径说的是「Agent 在工作区里删了它」，
   *     而目标 bucket 里同名的 key 属于别人。这是整个改动里唯一可能造成
   *     数据丢失的操作。
   *   - 按 runId 分目录 —— 不分的话两次 Run 都产出 report.md 时，
   *     后一次会静默覆盖前一次，而产物页上两条记录指向同一个 key。
   *   - 不看主挂载的 writable —— 主挂载是只读 git 工作树时它必然是 false，
   *     而那与「能不能往目标 bucket 写」毫无关系。
   */
  describe('投递到另一个目标（deliver）', () => {
    const gitWs = (path: string): import('@apos/contracts').Workspace => ({
      id: 'w',
      runId: 'run-1',
      root: path,
      // ★ 主挂载是**只读的 git 工作树** —— 正是 deliver 要支持的形态
      mounts: [
        {
          path,
          role: 'primary',
          writable: false,
          source: { kind: 'git', identifier: 'repo-1', label: 'order-service', baseVersion: 'abc' },
        },
      ],
      writable: false,
    });

    it('★ 只上传、绝不删除目标里的对象', async () => {
      const { fetchImpl, writes, store } = fakeBucket({ 'runs/gone.txt': '目标里本来就有的东西' });
      const m = materializer(fetchImpl);
      const path = join(root, 'runs', 'd1', 'repo');
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'report.md'), '# 报告');

      const result = await new ObjectStoragePublisher(m, {
        resolveStore: async () => STORE,
        mode: 'deliver',
      }).publish(
        gitWs(path),
        { added: ['report.md'], modified: [], deleted: ['gone.txt'], total: 2, truncated: false },
        ctx,
      );

      if (result.kind !== 'object_storage') return;
      expect(result.uploaded).toBe(1);
      expect(result.removed).toBe(0);
      expect(writes.some((w) => w.method === 'DELETE')).toBe(false);
      // 目标里原有的对象原封不动
      expect(store.get('runs/gone.txt')).toBe('目标里本来就有的东西');
    });

    it('★ 落在 {前缀}{runId}/ 下，两次 Run 不会互相覆盖', async () => {
      const { fetchImpl, store } = fakeBucket();
      const m = materializer(fetchImpl);
      const path = join(root, 'runs', 'd2', 'repo');
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'report.md'), '# 报告');

      const result = await new ObjectStoragePublisher(m, {
        resolveStore: async () => STORE,
        mode: 'deliver',
      }).publish(
        gitWs(path),
        { added: ['report.md'], modified: [], deleted: [], total: 1, truncated: false },
        ctx,
      );

      if (result.kind !== 'object_storage') return;
      expect(result.prefix).toBe('runs/run-1/');
      expect(store.get('runs/run-1/report.md')).toBe('# 报告');
      expect(result.note).toContain('投递');
    });

    it('★ 主挂载只读不影响投递 —— 可写性是目标的属性，不是挂载的', async () => {
      const { fetchImpl } = fakeBucket();
      const m = materializer(fetchImpl);
      const path = join(root, 'runs', 'd3', 'repo');
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'a.txt'), 'A');

      const result = await new ObjectStoragePublisher(m, {
        resolveStore: async () => STORE,
        mode: 'deliver',
      }).publish(
        gitWs(path),
        { added: ['a.txt'], modified: [], deleted: [], total: 1, truncated: false },
        ctx,
      );

      if (result.kind !== 'object_storage') return;
      expect(result.uploaded).toBe(1);
      expect(result.persisted).toBe(true);
    });

    /** ★ 变更集不完整时照样拒绝上传 —— 这条纪律对两种语义都成立 */
    it('变更集不完整时不投递', async () => {
      const { fetchImpl, writes } = fakeBucket();
      const m = materializer(fetchImpl);
      const path = join(root, 'runs', 'd4', 'repo');
      await mkdir(path, { recursive: true });

      const result = await new ObjectStoragePublisher(m, {
        resolveStore: async () => STORE,
        mode: 'deliver',
      }).publish(
        gitWs(path),
        { added: ['a.txt'], modified: [], deleted: [], total: 1, truncated: true },
        ctx,
      );

      if (result.kind !== 'object_storage') return;
      expect(result.persisted).toBe(false);
      expect(writes).toHaveLength(0);
    });
  });
});
