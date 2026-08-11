import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Mount } from '@apos/contracts';
import { EmptyMaterializer } from './sources/empty';
import { NonePublisher } from './publishers/none';

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'apos-empty-'));
  dir = join(root, 'runs', 'r1', 'work');
});

function materializer(over: { ignoredDirs?: string[] } = {}) {
  return new EmptyMaterializer({ root, ...over });
}

/** 让 mtime 一定变 —— 同一毫秒内的两次写入 stamp 会相同 */
async function touchLater(path: string, content: string) {
  await new Promise((r) => setTimeout(r, 5));
  await writeFile(path, content, 'utf8');
}

describe('空目录后端的基线与变更集', () => {
  it('建目录并记下基线，baseVersion 不是 null', async () => {
    const m = materializer();
    const mount = await m.materialize({ role: 'primary', writable: true, path: dir, workspaceId: 'r1' });

    expect(mount.source.kind).toBe('empty');
    expect(mount.source.baseVersion).toBeTruthy();
    expect(mount.writable).toBe(true);
  });

  it('分出增 / 改 / 删，而不是把目录里所有文件都报成产物', async () => {
    const m = materializer();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'existing.md'), '原有内容\n');
    await writeFile(join(dir, 'untouched.md'), '没动过\n');

    const mount = await m.materialize({ role: 'primary', writable: true, path: dir, workspaceId: 'r1' });

    await writeFile(join(dir, 'new-output.json'), '{"a":1}\n');
    await touchLater(join(dir, 'existing.md'), '改过了，长度也变了\n');
    await rm(join(dir, 'untouched.md'));

    const changes = await m.diff(mount);

    expect(changes.added).toEqual(['new-output.json']);
    expect(changes.modified).toEqual(['existing.md']);
    expect(changes.deleted).toEqual(['untouched.md']);
    expect(changes.total).toBe(3);
  });

  /**
   * ★★ 这条是空目录后端存在基线概念的全部理由。
   *
   *   没有基线的实现只能「扫描目录里有什么」，于是平台自己写进去的任务书
   *   会被当成 Agent 的产出记进产物 —— 而真正的产出淹没在里面。
   */
  it('seed 写入的平台输入文件算进基线，不出现在变更集里', async () => {
    const m = materializer();
    const mount = await m.materialize({
      role: 'primary',
      writable: true,
      path: dir,
      workspaceId: 'r1',
      seed: async (p) => {
        await writeFile(join(p, 'BRIEF.md'), '任务书\n', 'utf8');
      },
    });

    await writeFile(join(dir, 'PLAN.json'), '{}\n');
    const changes = await m.diff(mount);

    expect(changes.added).toEqual(['PLAN.json']);
    expect(changes.added).not.toContain('BRIEF.md');
    expect(changes.total).toBe(1);
  });

  it('子目录里的产出带相对路径', async () => {
    const m = materializer();
    const mount = await m.materialize({ role: 'primary', writable: true, path: dir, workspaceId: 'r1' });

    await mkdir(join(dir, 'out', 'deep'), { recursive: true });
    await writeFile(join(dir, 'out', 'deep', 'report.md'), '# r\n');

    const changes = await m.diff(mount);
    expect(changes.added).toEqual([join('out', 'deep', 'report.md')]);
  });

  it('配置忽略的目录不进基线也不进变更集', async () => {
    const m = materializer({ ignoredDirs: ['node_modules'] });
    const mount = await m.materialize({ role: 'primary', writable: true, path: dir, workspaceId: 'r1' });

    await mkdir(join(dir, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'left-pad', 'index.js'), 'x\n');
    await writeFile(join(dir, 'real.md'), 'y\n');

    const changes = await m.diff(mount);
    expect(changes.added).toEqual(['real.md']);
  });

  /**
   * ★ 基线丢了就说不知道，而不是把整个目录报成新增 —— 后者正是
   *   「扫描目录」那条错路，会把平台输入连同 Agent 产出一起当成产物。
   */
  it('基线快照丢失时如实报告变更集不可用，不猜', async () => {
    const m = materializer();
    const mount = await m.materialize({ role: 'primary', writable: true, path: dir, workspaceId: 'r1' });
    await writeFile(join(dir, 'a.txt'), 'a\n');

    await rm(join(root, 'state'), { recursive: true, force: true });

    const changes = await m.diff(mount);
    expect(changes.truncated).toBe(true);
    expect(changes.total).toBe(0);
    expect(changes.added).toEqual([]);
  });

  it('回收时清掉快照；keep 时保留目录内容', async () => {
    const m = materializer();
    const mount = await m.materialize({ role: 'primary', writable: true, path: dir, workspaceId: 'r1' });
    await writeFile(join(dir, 'keep-me.md'), 'x\n');

    await m.dispose(mount, { keep: true });

    // 目录还在（规划任务要留着供人事后复查）
    const after = await m.diff(mount);
    expect(after.truncated).toBe(true); // 快照没了，所以说不出变更

    await m.dispose(mount);
    await expect(
      import('node:fs/promises').then((fs) => fs.stat(dir)),
    ).rejects.toThrow();
  });
});

describe('不交货的交货后端', () => {
  const ws = (path: string) => ({
    id: 'r1',
    runId: 'r1',
    root: path,
    writable: true,
    mounts: [
      {
        path,
        role: 'primary' as const,
        writable: true,
        source: { kind: 'empty' as const, identifier: 'k', label: 'work', baseVersion: 'v' },
      } satisfies Mount,
    ],
  });

  const ctx = {
    runId: 'r1',
    outcome: 'completed' as const,
    summary: 's',
    agentName: 'a',
    goal: 'g',
  };

  /**
   * ★★ 「本地即已发布」是自欺：目录通常收尾就被回收，容器一回收更是
   *   什么都不剩。标成已发布的代价是用户点开产物看到不存在的路径。
   */
  it('永远不报 persisted，如实说明位置不是持久存储', async () => {
    const result = await new NonePublisher().publish(
      ws('/tmp/w'),
      { added: ['a.md'], modified: [], deleted: [], total: 1, truncated: false },
      ctx,
    );

    expect(result.kind).toBe('none');
    if (result.kind !== 'none') return;
    expect(result.persisted).toBe(false);
    expect(result.note).toContain('/tmp/w');
    expect(result.note).toContain('未上传到持久存储');
  });

  it('变更集不完整时说清楚，不报一个假的改动数', async () => {
    const result = await new NonePublisher().publish(
      ws('/tmp/w'),
      { added: [], modified: [], deleted: [], total: 0, truncated: true },
      ctx,
    );

    if (result.kind !== 'none') return;
    expect(result.note).toContain('变更集不完整');
  });
});
