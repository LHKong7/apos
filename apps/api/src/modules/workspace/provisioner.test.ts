import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agentRuns, repositories } from '@apos/db';
import type { AgentPermissions } from '@apos/contracts';
import { createWorkItem, resetDb, seedFixture, testDb, type Fixture } from '../../test/db';
import { seedAgent } from '../../test/agent-fixtures';
import { MockRuntime, RuntimeRegistry } from '@apos/agent-runtimes';
import { dispatchRun } from '../agent/dispatch';
import { git, probeGit } from './git';
import { buildBranchName, WorkspaceProvisioner } from './provisioner';

const db = testDb();
let fx: Fixture;
let root: string;
let remote: string;

const gitReady = await probeGit();

/** 造一个本地裸仓库当远端 —— 不碰网络 */
async function makeRemote(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'apos-remote-'));
  const work = join(dir, 'work');
  const bare = join(dir, 'origin.git');

  await git.run(['init', '-b', 'main', work]);
  await writeFile(join(work, 'README.md'), '# demo\n');
  await git.run(['add', '-A'], { cwd: work });
  await git.run(
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'],
    { cwd: work },
  );
  await git.run(['clone', '--bare', work, bare]);
  return bare;
}

beforeEach(async () => {
  await resetDb(db);
  fx = await seedFixture(db);
  root = await mkdtemp(join(tmpdir(), 'apos-ws-'));
  if (gitReady.ok) remote = await makeRemote();
});

afterAll(async () => {
  await resetDb(db);
});

async function registerRepo(over: Partial<typeof repositories.$inferInsert> = {}) {
  const [row] = await db
    .insert(repositories)
    .values({
      orgId: fx.orgId,
      ref: 'order-service',
      name: 'Order Service',
      remoteUrl: remote,
      defaultBranch: 'main',
      createdBy: fx.userId,
      ...over,
    })
    .returning();
  return row!;
}

function scopes(access: 'read' | 'write' = 'write', ref = 'order-service'): AgentPermissions {
  return {
    allowedTools: ['Read', 'Edit'],
    deniedTools: [],
    resourceScopes: [{ kind: 'repo', ref, access }],
  };
}

async function acquireFor(
  provisioner: WorkspaceProvisioner,
  permissions: AgentPermissions,
  runId = randomUUID(),
) {
  const item = await createWorkItem(db, fx, { status: 'ready', title: '修复登录超时' });
  await db.insert(agentRuns).values({
    id: runId,
    orgId: fx.orgId,
    projectId: fx.projectId,
    workItemId: item.id,
    agentId: (await seedAgent(db, fx, { name: `a-${runId.slice(0, 6)}` })).agentId,
    attempt: 1,
    status: 'dispatching',
    idempotencyKey: runId,
    goal: item.title,
  });

  return {
    runId,
    item,
    result: await provisioner.acquire({
      runId,
      orgId: fx.orgId,
      projectId: fx.projectId,
      workItemId: item.id,
      workItemTitle: item.title,
      permissions,
    }),
  };
}

describe('分支命名', () => {
  it('带任务信息与 Run 前缀，人在 PR 列表里能认出来', () => {
    const b = buildBranchName('apos/', 'Fix login timeout', 'a1b2c3d4-0000-0000-0000-000000000000');
    expect(b).toBe('apos/fix-login-timeout-a1b2c3d4');
  });

  it('标题全是符号时退回到 task，不产生非法分支名', () => {
    expect(buildBranchName('apos/', '???', 'abcdef12-0000-0000-0000-000000000000')).toBe(
      'apos/task-abcdef12',
    );
  });
});

describe('未授予仓库范围时', () => {
  it('不供给工作区，但这不是错误 —— 调研/文档类任务本来就不需要', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    const { result } = await acquireFor(p, {
      allowedTools: ['WebSearch'],
      deniedTools: [],
      resourceScopes: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.workspace).toBeNull();
  });
});

describe.skipIf(!gitReady.ok)('工作区供给（真实 git）', () => {
  it('挂出独立工作树，切到新分支，基线是默认分支', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    await registerRepo();

    const { result } = await acquireFor(p, scopes('write'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ws = result.workspace!;
    expect(ws.repoRef).toBe('order-service');
    expect(ws.writable).toBe(true);
    expect(ws.branch.startsWith('apos/')).toBe(true);
    expect(await readFile(join(ws.path, 'README.md'), 'utf8')).toContain('# demo');
    expect(await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ws.path })).toBe(ws.branch);
  });

  /**
   * ★ 这条是整个模块存在的理由。
   *   改造前所有 Run 共用一个 AGENT_WORKSPACE_ROOT，两个任务同时跑
   *   就在同一份工作树上互相覆盖。
   */
  it('并发的两个 Run 拿到互不相干的目录与分支', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    await registerRepo();

    const [a, b] = await Promise.all([
      acquireFor(p, scopes('write')),
      acquireFor(p, scopes('write')),
    ]);

    expect(a.result.ok && b.result.ok).toBe(true);
    if (!a.result.ok || !b.result.ok) return;

    const wa = a.result.workspace!;
    const wb = b.result.workspace!;
    expect(wa.path).not.toBe(wb.path);
    expect(wa.branch).not.toBe(wb.branch);

    // 一个 Run 写文件，另一个看不见
    await writeFile(join(wa.path, 'only-in-a.txt'), 'x');
    await expect(stat(join(wb.path, 'only-in-a.txt'))).rejects.toThrow();
  });

  it('授权了仓库但没登记时硬失败，不让 Agent 在空目录里开工', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    // 故意不 registerRepo

    const { result } = await acquireFor(p, scopes('write'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('没有在「代码仓库」里登记');
  });

  it('工作区信息落库，进程重启后还能知道改动在哪个分支', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    await registerRepo();
    const { runId, result } = await acquireFor(p, scopes('write'));
    expect(result.ok).toBe(true);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run!.workspace?.branch).toBeTruthy();
    expect(run!.workspace?.baseBranch).toBe('main');
  });

  it('成功收尾时提交并推送，工作树被回收', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    await registerRepo();
    const { runId, result } = await acquireFor(p, scopes('write'));
    if (!result.ok) throw new Error('acquire failed');

    const ws = result.workspace!;
    await writeFile(join(ws.path, 'fix.ts'), 'export const fixed = true;\n');

    const release = await p.release({
      runId,
      outcome: 'completed',
      summary: '修好了',
      agentName: 'code-agent-1',
    });

    expect(release.committed).toBe(true);
    expect(release.pushed).toBe(true);
    expect(release.changedFiles).toBe(1);

    // 远端真的有这个分支了
    const remoteBranches = await git.run(['branch', '--list', ws.branch], { cwd: remote });
    expect(remoteBranches).toContain(ws.branch);

    // 工作树回收，不占磁盘
    await expect(stat(ws.path)).rejects.toThrow();
  });

  /**
   * ★ 失败的改动同样要能被人看到。
   *   「测试没过所以我把代码扔了」是最糟的处置。
   */
  it('失败时本地提交但不推送，改动留在分支上可事后捞', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    await registerRepo();
    const { runId, result } = await acquireFor(p, scopes('write'));
    if (!result.ok) throw new Error('acquire failed');

    await writeFile(join(result.workspace!.path, 'half-done.ts'), '// wip\n');

    const release = await p.release({
      runId,
      outcome: 'failed',
      summary: '卡住了',
      agentName: 'code-agent-1',
    });

    expect(release.committed).toBe(true);
    expect(release.pushed).toBe(false);
    expect(release.note).toContain('未推送');

    const remoteBranches = await git.run(['branch', '--list', result.workspace!.branch], {
      cwd: remote,
    });
    expect(remoteBranches).toBe('');
  });

  it('Agent 什么都没改时不产生空提交', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    await registerRepo();
    const { runId } = await acquireFor(p, scopes('write'));

    const release = await p.release({
      runId,
      outcome: 'completed',
      summary: '无需改动',
      agentName: 'code-agent-1',
    });

    expect(release.committed).toBe(false);
    expect(release.changedFiles).toBe(0);
    expect(release.note).toContain('未改动');
  });

  /** ★ supervisor 判超时与事件流报 run_ended 可能同时到达 */
  it('重复收尾是幂等的，不会重复提交也不抛异常', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    await registerRepo();
    const { runId, result } = await acquireFor(p, scopes('write'));
    if (!result.ok) throw new Error('acquire failed');
    await writeFile(join(result.workspace!.path, 'x.ts'), 'x\n');

    const first = await p.release({ runId, outcome: 'completed', summary: 's', agentName: 'a' });
    const second = await p.release({ runId, outcome: 'completed', summary: 's', agentName: 'a' });

    expect(first.committed).toBe(true);
    expect(second.note).toContain('此前已收尾');
  });

  it('配置了核验命令时在提交前执行，结果如实回报', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    await registerRepo({ checkCommand: 'exit 1', checkTimeoutSeconds: 30 });
    const { runId, result } = await acquireFor(p, scopes('write'));
    if (!result.ok) throw new Error('acquire failed');
    await writeFile(join(result.workspace!.path, 'x.ts'), 'x\n');

    const release = await p.release({ runId, outcome: 'completed', summary: 's', agentName: 'a' });

    expect(release.check.ran).toBe(true);
    expect(release.check.passed).toBe(false);
    // ★ 核验失败也提交 —— 失败的改动同样需要被看到
    expect(release.committed).toBe(true);
  });

  it('核验通过时如实标记', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    await registerRepo({ checkCommand: 'exit 0', checkTimeoutSeconds: 30 });
    const { runId, result } = await acquireFor(p, scopes('write'));
    if (!result.ok) throw new Error('acquire failed');
    await writeFile(join(result.workspace!.path, 'x.ts'), 'x\n');

    const release = await p.release({ runId, outcome: 'completed', summary: 's', agentName: 'a' });
    expect(release.check.passed).toBe(true);
  });

  it('只读授权拿到的工作区标为不可写', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    await registerRepo();
    const { result } = await acquireFor(p, scopes('read'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.workspace!.writable).toBe(false);
  });

  it('清理孤儿目录时保留活跃 Run 的工作区', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    await registerRepo();
    const alive = await acquireFor(p, scopes('write'));
    const dead = await acquireFor(p, scopes('write'));
    if (!alive.result.ok || !dead.result.ok) throw new Error('acquire failed');

    const removed = await p.pruneOrphans([alive.runId]);
    expect(removed).toBe(1);
    await expect(stat(alive.result.workspace!.path)).resolves.toBeTruthy();
    await expect(stat(dead.result.workspace!.path)).rejects.toThrow();
  });

  /**
   * ★ 不 detached 的话这条会失败：`shell: true` 起的 shell 被杀掉之后，
   *   它后台起的那个 sleep 会活下来，3 秒后照样把文件写出来。
   */
  it('核验超时时连同后台子进程一起杀掉，不留孤儿', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    const marker = join(root, 'orphan-alive.txt');
    await registerRepo({
      checkCommand: `(sleep 3 && touch ${marker}) & wait`,
      checkTimeoutSeconds: 1,
    });
    const { runId, result } = await acquireFor(p, scopes('write'));
    if (!result.ok) throw new Error('acquire failed');
    await writeFile(join(result.workspace!.path, 'x.ts'), 'x\n');

    const release = await p.release({ runId, outcome: 'completed', summary: 's', agentName: 'a' });
    expect(release.check.ran).toBe(true);
    expect(release.check.passed).toBe(false);

    // 超过 sleep 3 还剩余量：孤儿活着的话这时候文件一定已经写出来了
    await new Promise((r) => setTimeout(r, 4000));
    await expect(stat(marker)).rejects.toThrow();
  }, 20_000);

  /**
   * ★ 参考挂载建分支的话，镜像里会按「Run 数 × 参考仓库数」永久堆积 ——
   *   而这些分支的内容与基线完全相同，没有任何留存价值。
   */
  it('只读参考仓库挂 detached 工作树，不在镜像里留分支', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    const primary = await registerRepo();
    const reference = await registerRepo({ ref: 'shared-lib', name: 'Shared Lib' });

    const { result } = await acquireFor(p, {
      allowedTools: ['Read'],
      deniedTools: [],
      resourceScopes: [
        { kind: 'repo', ref: 'order-service', access: 'write' },
        { kind: 'repo', ref: 'shared-lib', access: 'read' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.workspace!.additionalPaths).toHaveLength(1);
    // 参考仓库的工作树能读到文件（detached 不影响读）
    expect(
      await readFile(join(result.workspace!.additionalPaths[0]!, 'README.md'), 'utf8'),
    ).toContain('# demo');

    // 参考仓库的镜像里一条分支都没多出来
    const refBranches = await git.run(['branch', '--list'], {
      cwd: join(root, 'mirrors', `${reference.id}.git`),
    });
    expect(refBranches).not.toContain('-ref-');
    // 主仓库该有的工作分支还在
    const mainBranches = await git.run(['branch', '--list'], {
      cwd: join(root, 'mirrors', `${primary.id}.git`),
    });
    expect(mainBranches).toContain(result.workspace!.branch);
  });

  it('收尾时逐个回收挂载，参考仓库的工作树登记不残留', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    await registerRepo();
    const reference = await registerRepo({ ref: 'shared-lib', name: 'Shared Lib' });

    const { runId, result } = await acquireFor(p, {
      allowedTools: ['Read'],
      deniedTools: [],
      resourceScopes: [
        { kind: 'repo', ref: 'order-service', access: 'write' },
        { kind: 'repo', ref: 'shared-lib', access: 'read' },
      ],
    });
    if (!result.ok) throw new Error('acquire failed');
    const refPath = result.workspace!.additionalPaths[0]!;

    await p.release({ runId, outcome: 'completed', summary: 's', agentName: 'a' });

    // ★ 走的是 worktree remove，所以登记表里干干净净 —— 而不是 rm -rf 之后
    //   留一条 prunable 的记录等着下次 acquire 才被清掉
    const list = await git.run(['worktree', 'list', '--porcelain'], {
      cwd: join(root, 'mirrors', `${reference.id}.git`),
    });
    expect(list).not.toContain(refPath);
    await expect(stat(refPath)).rejects.toThrow();
  });

  it('推送成功后删掉镜像里的本地分支，失败的留着可事后捞', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    const repo = await registerRepo();
    const mirror = join(root, 'mirrors', `${repo.id}.git`);

    const ok = await acquireFor(p, scopes('write'));
    if (!ok.result.ok) throw new Error('acquire failed');
    await writeFile(join(ok.result.workspace!.path, 'a.ts'), 'a\n');
    await p.release({ runId: ok.runId, outcome: 'completed', summary: 's', agentName: 'a' });
    expect(await git.run(['branch', '--list', ok.result.workspace!.branch], { cwd: mirror })).toBe('');

    const bad = await acquireFor(p, scopes('write'));
    if (!bad.result.ok) throw new Error('acquire failed');
    await writeFile(join(bad.result.workspace!.path, 'b.ts'), 'b\n');
    await p.release({ runId: bad.runId, outcome: 'failed', summary: 's', agentName: 'a' });
    // ★ 没推送的必须留着 —— 这是失败改动唯一的载体
    expect(await git.run(['branch', '--list', bad.result.workspace!.branch], { cwd: mirror })).toContain(
      bad.result.workspace!.branch,
    );
  });

  it('派发链路端到端：Run 拿到真实工作目录', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    await registerRepo();

    const runtime = new MockRuntime({}, { steps: ['一步'], stepDelayMs: 0 });
    const registry = new RuntimeRegistry();
    const agent = await seedAgent(db, fx, {
      runtime,
      registry,
      allowedTools: ['read_file', 'write_file'],
    });
    await db
      .update(await import('@apos/db').then((m) => m.agents))
      .set({ resourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'write' }] })
      .where(eq((await import('@apos/db')).agents.id, agent.agentId));

    const item = await createWorkItem(db, fx, { status: 'ready' });
    const res = await dispatchRun(
      db,
      registry,
      { workItemId: item.id, agentId: agent.agentId, correlationId: randomUUID() },
      { workspaces: p },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const dispatched = runtime.dispatchedTask(res.runId);
    expect(dispatched?.workspace?.path).toContain(res.runId);
    expect(dispatched?.workspace?.repoRef).toBe('order-service');
  });

  it('git 不可用时给出可行动的报错，而不是留下半个工作区', async () => {
    const p = new WorkspaceProvisioner(db, { root });
    await registerRepo({ ref: 'ghost', remoteUrl: join(root, 'does-not-exist.git') });

    const { runId, result } = await acquireFor(p, scopes('write', 'ghost'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('准备工作区失败');

    await expect(stat(join(root, 'runs', runId))).rejects.toThrow();
  });
});
