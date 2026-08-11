import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Mount } from '@apos/contracts';
import { LocalMaterializer, LocalMountError } from './source';
import { LocalPublisher } from './publisher';

let root: string;
let hostDir: string;
let archive: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'apos-local-'));
  hostDir = join(root, 'host', 'dataset');
  archive = join(root, 'archive');
  await mkdir(hostDir, { recursive: true });
  await writeFile(join(hostDir, 'input.csv'), 'a,b\n1,2\n');
  await mkdir(join(hostDir, 'nested'), { recursive: true });
  await writeFile(join(hostDir, 'nested', 'note.md'), '# note\n');
});

const dir = (over: Partial<{ id: string; ref: string; rootPath: string }> = {}) => ({
  id: 't1',
  ref: 'sales-data',
  rootPath: hostDir,
  ...over,
});

function materializer(over: { allowedRoots?: string[] } = {}) {
  return new LocalMaterializer({ root, ...over });
}

describe('本地目录铺料', () => {
  /**
   * ★★ 复制而不是让 Agent 直接在源目录里干活：两个并发 Run 会互相覆盖，
   *   而失败的 Run 会把源目录改坏且没有东西能还原它。
   */
  it('把宿主目录复制进工作区，源目录不受 Agent 改动影响', async () => {
    const m = materializer();
    const target = join(root, 'runs', 'r1', 'sales-data');
    const mount = await m.materialize({ role: 'primary', writable: true, path: target, dir: dir(), workspaceId: 'r1' });

    expect(await readFile(join(target, 'input.csv'), 'utf8')).toContain('1,2');
    expect(await readFile(join(target, 'nested', 'note.md'), 'utf8')).toContain('# note');

    await writeFile(join(target, 'input.csv'), '改坏了\n');
    expect(await readFile(join(hostDir, 'input.csv'), 'utf8')).toContain('1,2');

    expect(mount.source.kind).toBe('local');
    expect(mount.source.label).toBe('sales-data');
    expect(mount.source.baseVersion).toBeTruthy();
  });

  it('变更集只报 Agent 动过的，铺进来的原始内容不算产出', async () => {
    const m = materializer();
    const target = join(root, 'runs', 'r2', 'sales-data');
    const mount = await m.materialize({ role: 'primary', writable: true, path: target, dir: dir(), workspaceId: 'r2' });

    await new Promise((r) => setTimeout(r, 5));
    await writeFile(join(target, 'result.json'), '{"ok":true}\n');

    const changes = await m.diff(mount);
    expect(changes.added).toEqual(['result.json']);
    expect(changes.modified).toEqual([]);
    expect(changes.total).toBe(1);
  });

  /**
   * ★★ 白名单是部署方的最后一道闸。「登记」是管理员在界面上做的事，
   *   一条填成 `/` 的登记等于把整台机器交给 Agent。
   */
  it('白名单之外的目录拒绝挂载', async () => {
    const m = materializer({ allowedRoots: [join(root, 'allowed')] });
    await expect(
      m.materialize({ role: 'primary', writable: true, path: join(root, 'w'), dir: dir(), workspaceId: 'r3' }),
    ).rejects.toThrow(LocalMountError);
  });

  it('白名单内的子目录放行', async () => {
    const m = materializer({ allowedRoots: [join(root, 'host')] });
    const mount = await m.materialize({
      role: 'primary',
      writable: true,
      path: join(root, 'runs', 'r4', 'd'),
      dir: dir(),
      workspaceId: 'r4',
    });
    expect(mount.path).toContain('r4');
  });

  /** ★ 比的是解析后的绝对路径且要求边界对齐，否则 /data/public 会放行 /data/public-secrets */
  it('前缀相同但不是子目录的路径不放行', async () => {
    const sibling = join(root, 'host-secrets');
    await mkdir(sibling, { recursive: true });
    const m = materializer({ allowedRoots: [join(root, 'host')] });

    await expect(
      m.materialize({
        role: 'primary',
        writable: true,
        path: join(root, 'w2'),
        dir: dir({ rootPath: sibling }),
        workspaceId: 'r5',
      }),
    ).rejects.toThrow(LocalMountError);
  });

  /**
   * ★ 不跟进符号链接：跟进的话一条指向 /etc 的链接就会把宿主机配置
   *   复制进 Agent 的工作区，而白名单挡的是挂载点，不是挂载点里的链接目标。
   */
  it('符号链接原样复制，不跟进目标', async () => {
    await symlink('/etc', join(hostDir, 'escape'));
    const m = materializer();
    const target = join(root, 'runs', 'r6', 'd');
    await m.materialize({ role: 'primary', writable: true, path: target, dir: dir(), workspaceId: 'r6' });

    const st = await stat(join(target, 'escape')).catch(() => null);
    const lst = await (await import('node:fs/promises')).lstat(join(target, 'escape'));
    expect(lst.isSymbolicLink()).toBe(true);
    // 链接本身在，但没有把 /etc 的内容抄进来
    expect(st === null || st.isDirectory()).toBe(true);
    await expect(stat(join(target, 'escape.copied'))).rejects.toThrow();
  });

  it('登记的目录不存在时报错，而不是挂一个空目录让 Agent 白跑', async () => {
    const m = materializer();
    await expect(
      m.materialize({
        role: 'primary',
        writable: true,
        path: join(root, 'w3'),
        dir: dir({ rootPath: join(root, 'nope') }),
        workspaceId: 'r7',
      }),
    ).rejects.toThrow(/不存在或不是目录/);
  });
});

describe('本地归档交货', () => {
  const ctx = {
    runId: 'run-1',
    outcome: 'completed' as const,
    summary: 's',
    agentName: 'a',
    goal: 'g',
  };

  async function workspaceWith(files: Record<string, string>): Promise<{ ws: import('@apos/contracts').Workspace; path: string }> {
    const path = join(root, 'runs', 'pub', 'work');
    await mkdir(path, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(join(path, rel, '..'), { recursive: true });
      await writeFile(join(path, rel), content);
    }
    const mount: Mount = {
      path,
      role: 'primary',
      writable: true,
      source: { kind: 'local', identifier: 'k', label: 'sales-data', baseVersion: 'v' },
    };
    return { ws: { id: 'pub', runId: 'run-1', root: path, mounts: [mount], writable: true }, path };
  }

  /**
   * ★ 只复制变更集里的文件。一个仓库检出有几万个文件，Agent 改了 3 个 ——
   *   归档那 3 个就够了，其余的在源头有。
   */
  it('只归档变更集里的文件，并如实报 persisted', async () => {
    const { ws } = await workspaceWith({ 'a.txt': 'A', 'b.txt': 'B', 'untouched.txt': 'U' });
    const result = await new LocalPublisher({ archiveRoot: archive }).publish(
      ws,
      { added: ['a.txt'], modified: ['b.txt'], deleted: [], total: 2, truncated: false },
      ctx,
    );

    expect(result.kind).toBe('local');
    if (result.kind !== 'local') return;
    expect(result.persisted).toBe(true);
    expect(result.files).toBe(2);

    expect(await readFile(join(archive, 'run-1', 'a.txt'), 'utf8')).toBe('A');
    expect(await readFile(join(archive, 'run-1', 'b.txt'), 'utf8')).toBe('B');
    await expect(stat(join(archive, 'run-1', 'untouched.txt'))).rejects.toThrow();
  });

  /**
   * ★★ 照着一份不完整的清单归档，产出的是一个看起来成功、实际缺文件的归档，
   *   而缺了什么没有任何地方说得出来。宁可什么都不做并说清楚。
   */
  it('变更集不完整时拒绝归档并说明原因', async () => {
    const { ws, path } = await workspaceWith({ 'a.txt': 'A' });
    const result = await new LocalPublisher({ archiveRoot: archive }).publish(
      ws,
      { added: [], modified: [], deleted: [], total: 0, truncated: true },
      ctx,
    );

    if (result.kind !== 'local') return;
    expect(result.persisted).toBe(false);
    expect(result.note).toContain('变更集不完整');
    expect(result.note).toContain(path);
  });

  it('删除的文件在归档里也删掉 —— 归档反映收尾时的状态而不是历次叠加', async () => {
    const { ws } = await workspaceWith({ 'keep.txt': 'K' });
    const publisher = new LocalPublisher({ archiveRoot: archive });

    await publisher.publish(ws, { added: ['keep.txt'], modified: [], deleted: [], total: 1, truncated: false }, ctx);
    await writeFile(join(archive, 'run-1', 'stale.txt'), 'old');

    await publisher.publish(
      ws,
      { added: [], modified: ['keep.txt'], deleted: ['stale.txt'], total: 2, truncated: false },
      ctx,
    );
    await expect(stat(join(archive, 'run-1', 'stale.txt'))).rejects.toThrow();
  });

  /** ★ 越界的相对路径会覆盖别的 Run 的产物 */
  it('拒绝越界的相对路径', async () => {
    const { ws } = await workspaceWith({ 'a.txt': 'A' });
    const result = await new LocalPublisher({ archiveRoot: archive }).publish(
      ws,
      { added: ['../escape.txt'], modified: [], deleted: [], total: 1, truncated: false },
      ctx,
    );
    if (result.kind !== 'local') return;
    expect(result.persisted).toBe(false);
    expect(result.files).toBe(0);
  });

  it('归档目录不可写时 probe 说清楚，而不是等第一次收尾', async () => {
    const ok = await new LocalPublisher({ archiveRoot: archive }).probe();
    expect(ok.ok).toBe(true);

    // 在一个普通文件底下建目录 → ENOTDIR，是「配错了路径」最常见的形态
    const blocker = join(root, 'not-a-dir');
    await writeFile(blocker, 'x');
    const bad = await new LocalPublisher({ archiveRoot: join(blocker, 'archive') }).probe();
    expect(bad.ok).toBe(false);
    expect(bad.problem).toContain('不可写');
  });
});
