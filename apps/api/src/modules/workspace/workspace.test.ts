import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agentRuns, artifacts, repositories, storageTargets } from '@apos/db';
import type { AgentPermissions } from '@apos/contracts';
import { createWorkItem, resetDb, seedFixture, testDb, type Fixture } from '../../test/db';
import { seedAgent } from '../../test/agent-fixtures';
import { MockRuntime, RuntimeRegistry } from '@apos/agent-runtimes';
import { dispatchRun } from '../agent/dispatch';
import { ingestRunEvent } from '../agent/ingest';
import { git, probeGit } from '@apos/workspace-providers';
import { buildBranchName, WorkspaceService } from './index';

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
  provisioner: WorkspaceService,
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
    const p = new WorkspaceService(db, { root });
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
    const p = new WorkspaceService(db, { root });
    await registerRepo();

    const { result } = await acquireFor(p, scopes('write'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ws = result.workspace!;
    expect(ws.vcs!.repoRef).toBe('order-service');
    expect(ws.writable).toBe(true);
    expect(ws.vcs!.branch.startsWith('apos/')).toBe(true);
    expect(await readFile(join(ws.path, 'README.md'), 'utf8')).toContain('# demo');
    expect(await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ws.path })).toBe(ws.vcs!.branch);
  });

  /**
   * ★ 这条是整个模块存在的理由。
   *   改造前所有 Run 共用一个 AGENT_WORKSPACE_ROOT，两个任务同时跑
   *   就在同一份工作树上互相覆盖。
   */
  it('并发的两个 Run 拿到互不相干的目录与分支', async () => {
    const p = new WorkspaceService(db, { root });
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
    expect(wa.vcs!.branch).not.toBe(wb.vcs!.branch);

    // 一个 Run 写文件，另一个看不见
    await writeFile(join(wa.path, 'only-in-a.txt'), 'x');
    await expect(stat(join(wb.path, 'only-in-a.txt'))).rejects.toThrow();
  });

  it('授权了仓库但没登记时硬失败，不让 Agent 在空目录里开工', async () => {
    const p = new WorkspaceService(db, { root });
    // 故意不 registerRepo

    const { result } = await acquireFor(p, scopes('write'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('没有在「工作区来源」里登记为代码仓库');
  });

  it('工作区信息落库，进程重启后还能知道改动在哪个分支', async () => {
    const p = new WorkspaceService(db, { root });
    await registerRepo();
    const { runId, result } = await acquireFor(p, scopes('write'));
    expect(result.ok).toBe(true);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run!.workspace?.branch).toBeTruthy();
    expect(run!.workspace?.baseBranch).toBe('main');
  });

  it('成功收尾时提交并推送，工作树被回收', async () => {
    const p = new WorkspaceService(db, { root });
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
    const remoteBranches = await git.run(['branch', '--list', ws.vcs!.branch], { cwd: remote });
    expect(remoteBranches).toContain(ws.vcs!.branch);

    // 工作树回收，不占磁盘
    await expect(stat(ws.path)).rejects.toThrow();
  });

  /**
   * ★ 失败的改动同样要能被人看到。
   *   「测试没过所以我把代码扔了」是最糟的处置。
   */
  it('失败时本地提交但不推送，改动留在分支上可事后捞', async () => {
    const p = new WorkspaceService(db, { root });
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

    const remoteBranches = await git.run(['branch', '--list', result.workspace!.vcs!.branch], {
      cwd: remote,
    });
    expect(remoteBranches).toBe('');
  });

  it('Agent 什么都没改时不产生空提交', async () => {
    const p = new WorkspaceService(db, { root });
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
    const p = new WorkspaceService(db, { root });
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
    const p = new WorkspaceService(db, { root });
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
    const p = new WorkspaceService(db, { root });
    await registerRepo({ checkCommand: 'exit 0', checkTimeoutSeconds: 30 });
    const { runId, result } = await acquireFor(p, scopes('write'));
    if (!result.ok) throw new Error('acquire failed');
    await writeFile(join(result.workspace!.path, 'x.ts'), 'x\n');

    const release = await p.release({ runId, outcome: 'completed', summary: 's', agentName: 'a' });
    expect(release.check.passed).toBe(true);
  });

  it('只读授权拿到的工作区标为不可写', async () => {
    const p = new WorkspaceService(db, { root });
    await registerRepo();
    const { result } = await acquireFor(p, scopes('read'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.workspace!.writable).toBe(false);
  });

  it('清理孤儿目录时保留活跃 Run 的工作区', async () => {
    const p = new WorkspaceService(db, { root });
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
    const p = new WorkspaceService(db, { root });
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
    const p = new WorkspaceService(db, { root });
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
    expect(mainBranches).toContain(result.workspace!.vcs!.branch);
  });

  it('收尾时逐个回收挂载，参考仓库的工作树登记不残留', async () => {
    const p = new WorkspaceService(db, { root });
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
    const p = new WorkspaceService(db, { root });
    const repo = await registerRepo();
    const mirror = join(root, 'mirrors', `${repo.id}.git`);

    const ok = await acquireFor(p, scopes('write'));
    if (!ok.result.ok) throw new Error('acquire failed');
    await writeFile(join(ok.result.workspace!.path, 'a.ts'), 'a\n');
    await p.release({ runId: ok.runId, outcome: 'completed', summary: 's', agentName: 'a' });
    expect(await git.run(['branch', '--list', ok.result.workspace!.vcs!.branch], { cwd: mirror })).toBe('');

    const bad = await acquireFor(p, scopes('write'));
    if (!bad.result.ok) throw new Error('acquire failed');
    await writeFile(join(bad.result.workspace!.path, 'b.ts'), 'b\n');
    await p.release({ runId: bad.runId, outcome: 'failed', summary: 's', agentName: 'a' });
    // ★ 没推送的必须留着 —— 这是失败改动唯一的载体
    expect(await git.run(['branch', '--list', bad.result.workspace!.vcs!.branch], { cwd: mirror })).toContain(
      bad.result.workspace!.vcs!.branch,
    );
  });

  /**
   * ★ 「改了哪些文件」比「改了几个文件」有用得多，而这个信息在算 diff 的
   *   那一刻本来就在手上。此前只留下一个计数，评审时想知道动了什么
   *   只能去翻分支。
   */
  it('变更集分出增/改/删三类，带文件名', async () => {
    const p = new WorkspaceService(db, { root });
    await registerRepo();
    const { runId, result } = await acquireFor(p, scopes('write'));
    if (!result.ok) throw new Error('acquire failed');
    const dir = result.workspace!.path;

    await writeFile(join(dir, 'brand-new.ts'), 'export const x = 1;\n');
    await writeFile(join(dir, 'README.md'), '# demo\n\n改过了\n');
    await rm(join(dir, '.gitignore'), { force: true }).catch(() => undefined);

    const release = await p.release({ runId, outcome: 'completed', summary: 's', agentName: 'a' });

    expect(release.changes.added).toContain('brand-new.ts');
    expect(release.changes.modified).toContain('README.md');
    expect(release.changes.total).toBe(2);
    expect(release.changes.truncated).toBe(false);
    // 旧字段仍然是同一个数，消费方不用一次全改
    expect(release.changedFiles).toBe(release.changes.total);
  });

  it('删除的文件进 deleted，不被当成修改', async () => {
    const p = new WorkspaceService(db, { root });
    await registerRepo();
    const { runId, result } = await acquireFor(p, scopes('write'));
    if (!result.ok) throw new Error('acquire failed');

    await rm(join(result.workspace!.path, 'README.md'));

    const release = await p.release({ runId, outcome: 'completed', summary: 's', agentName: 'a' });
    expect(release.changes.deleted).toEqual(['README.md']);
    expect(release.changes.modified).toEqual([]);
  });

  /**
   * ★ 文件名里**允许**有换行。按 \n 切 porcelain 输出会把一个文件算成两个，
   *   而虚高的改动数会进提交信息和产物标题。用 -z 就没这个问题。
   */
  it('文件名里带换行时不会被算成两个文件', async () => {
    const p = new WorkspaceService(db, { root });
    await registerRepo();
    const { runId, result } = await acquireFor(p, scopes('write'));
    if (!result.ok) throw new Error('acquire failed');

    await writeFile(join(result.workspace!.path, 'weird\nname.txt'), 'x\n');

    const release = await p.release({ runId, outcome: 'completed', summary: 's', agentName: 'a' });
    expect(release.changes.total).toBe(1);
    expect(release.changes.added).toHaveLength(1);
  });

  it('交货结果按后端收窄，git 那支带分支与 commit', async () => {
    const p = new WorkspaceService(db, { root });
    await registerRepo();
    const { runId, result } = await acquireFor(p, scopes('write'));
    if (!result.ok) throw new Error('acquire failed');
    await writeFile(join(result.workspace!.path, 'x.ts'), 'x\n');

    const release = await p.release({ runId, outcome: 'completed', summary: 's', agentName: 'a' });

    expect(release.published.kind).toBe('git');
    if (release.published.kind !== 'git') return;
    expect(release.published.branch).toBe(result.workspace!.vcs!.branch);
    expect(release.published.headCommit).toBe(release.headCommit);
    expect(release.published.pushed).toBe(true);
  });

  /**
   * ★ 产物落库走 published 的可辨识联合，不再假设一定是 Git。
   *   此前它直接读 result.branch / result.headCommit —— 换个后端全是 null。
   */
  it('run_ended 收尾后把变更集落成产物，metadata 里带文件名', async () => {
    const p = new WorkspaceService(db, { root });
    await registerRepo();
    const { runId, result } = await acquireFor(p, scopes('write'));
    if (!result.ok) throw new Error('acquire failed');

    await writeFile(join(result.workspace!.path, 'fix.ts'), 'export const a = 1;\n');
    await writeFile(join(result.workspace!.path, 'README.md'), '# demo\n改了\n');

    await ingestRunEvent(
      db,
      {
        runId,
        event: {
          runId,
          seq: 1,
          ts: new Date().toISOString(),
          type: 'run_ended',
          outcome: 'completed',
          summary: '做完了',
        } as never,
        correlationId: randomUUID(),
      },
      { workspaces: p },
    );

    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.runId, runId));
    expect(artifact).toBeTruthy();

    const meta = artifact!.metadata as Record<string, never>;
    expect(meta['source']).toMatchObject({ kind: 'git', repoRef: 'order-service' });
    expect(meta['pushed']).toBe(true);
    expect(meta['changedFiles']).toBe(2);

    const changes = meta['changes'] as unknown as {
      added: string[];
      modified: string[];
      listTruncated: boolean;
      incomplete: boolean;
    };
    expect(changes.added).toContain('fix.ts');
    expect(changes.modified).toContain('README.md');
    // 两个文件远没到 200 的上限，也没有不完整
    expect(changes.listTruncated).toBe(false);
    expect(changes.incomplete).toBe(false);
  });

  it('Agent 什么都没改时不落产物 —— 一条「0 个文件」只会污染评审视图', async () => {
    const p = new WorkspaceService(db, { root });
    await registerRepo();
    const { runId } = await acquireFor(p, scopes('write'));

    await ingestRunEvent(
      db,
      {
        runId,
        event: {
          runId,
          seq: 1,
          ts: new Date().toISOString(),
          type: 'run_ended',
          outcome: 'completed',
          summary: '无需改动',
        } as never,
        correlationId: randomUUID(),
      },
      { workspaces: p },
    );

    const rows = await db.select().from(artifacts).where(eq(artifacts.runId, runId));
    expect(rows).toHaveLength(0);
  });

  /**
   * ★ dataset 类范围解析到 storage_targets，而不是硬塞进 repositories。
   *   一个本地目录塞进那张表要给 remoteUrl / defaultBranch 填占位符，
   *   而占位符会一路流到界面和 prompt 里 —— 这正是规划任务曾经踩过的坑。
   */
  it('本地目录登记为存储目标后能被挂载，产出归档到工作区之外', async () => {
    const hostDir = join(root, 'host', 'sales');
    await mkdir(hostDir, { recursive: true });
    await writeFile(join(hostDir, 'input.csv'), 'a,b\n1,2\n');
    const archive = join(root, 'archive');

    const p = new WorkspaceService(db, { root, archiveRoot: archive });
    await db.insert(storageTargets).values({
      orgId: fx.orgId,
      ref: 'sales-data',
      name: '销售数据',
      kind: 'local',
      rootPath: hostDir,
      writable: true,
      createdBy: fx.userId,
    });

    const { runId, result } = await acquireFor(p, {
      allowedTools: ['Read', 'Edit'],
      deniedTools: [],
      resourceScopes: [{ kind: 'dataset', ref: 'sales-data', access: 'write' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ws = result.workspace!;
    // ★ 不是 git 工作区，所以 vcs 为 null —— prompt 会据此换一套说法
    expect(ws.vcs).toBeNull();
    expect(await readFile(join(ws.path, 'input.csv'), 'utf8')).toContain('1,2');

    await new Promise((r) => setTimeout(r, 5));
    await writeFile(join(ws.path, 'report.md'), '# 分析结果\n');

    const release = await p.release({ runId, outcome: 'completed', summary: 's', agentName: 'a' });

    expect(release.changes.added).toEqual(['report.md']);
    expect(release.published.kind).toBe('local');
    if (release.published.kind !== 'local') return;
    expect(release.published.persisted).toBe(true);
    // 归档在工作区之外，工作区目录已被回收
    expect(await readFile(join(archive, runId, 'report.md'), 'utf8')).toContain('分析结果');
    await expect(stat(ws.path)).rejects.toThrow();
    // 源目录没被 Agent 改动
    await expect(stat(join(hostDir, 'report.md'))).rejects.toThrow();
  });

  /**
   * ★ 没配归档目录时退回「不交货」并如实说明 —— LocalPublisher 的全部价值
   *   就是把东西搬到工作区之外，没有归档目录它搬不到任何地方。
   */
  it('没配归档目录时不谎报已持久化', async () => {
    const hostDir = join(root, 'host2');
    await mkdir(hostDir, { recursive: true });
    await writeFile(join(hostDir, 'a.txt'), 'a\n');

    const p = new WorkspaceService(db, { root });
    await db.insert(storageTargets).values({
      orgId: fx.orgId,
      ref: 'plain-dir',
      name: '目录',
      kind: 'local',
      rootPath: hostDir,
      writable: true,
      createdBy: fx.userId,
    });

    const { runId, result } = await acquireFor(p, {
      allowedTools: ['Read'],
      deniedTools: [],
      resourceScopes: [{ kind: 'dataset', ref: 'plain-dir', access: 'write' }],
    });
    if (!result.ok) throw new Error('acquire failed');
    await writeFile(join(result.workspace!.path, 'out.txt'), 'x\n');

    const release = await p.release({ runId, outcome: 'completed', summary: 's', agentName: 'a' });
    expect(release.published.kind).toBe('none');
    if (release.published.kind !== 'none') return;
    expect(release.published.persisted).toBe(false);
  });

  it('数据集没登记时报错指向「存储目标」而不是「代码仓库」', async () => {
    const p = new WorkspaceService(db, { root });
    const { result } = await acquireFor(p, {
      allowedTools: ['Read'],
      deniedTools: [],
      resourceScopes: [{ kind: 'dataset', ref: 'ghost-bucket', access: 'read' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('没有在「工作区来源」里登记为存储目标');
  });

  /** ★ 交货只对主挂载做：既挂仓库又挂数据集时，产出该进仓库分支而不是覆盖数据集 */
  it('同时挂仓库与数据集时，仓库是主挂载、数据集是只读参考', async () => {
    const hostDir = join(root, 'host3');
    await mkdir(hostDir, { recursive: true });
    await writeFile(join(hostDir, 'ref.csv'), 'x\n');

    const p = new WorkspaceService(db, { root });
    await registerRepo();
    await db.insert(storageTargets).values({
      orgId: fx.orgId,
      ref: 'lookup',
      name: '查表数据',
      kind: 'local',
      rootPath: hostDir,
      createdBy: fx.userId,
    });

    const { runId, result } = await acquireFor(p, {
      allowedTools: ['Read', 'Edit'],
      deniedTools: [],
      resourceScopes: [
        { kind: 'dataset', ref: 'lookup', access: 'read' },
        { kind: 'repo', ref: 'order-service', access: 'write' },
      ],
    });
    if (!result.ok) throw new Error('acquire failed');

    // 仓库当主挂载（有 vcs），数据集挂成只读参考
    expect(result.workspace!.vcs?.repoRef).toBe('order-service');
    expect(result.workspace!.additionalPaths).toHaveLength(1);
    expect(await readFile(join(result.workspace!.additionalPaths[0]!, 'ref.csv'), 'utf8')).toBe('x\n');

    await writeFile(join(result.workspace!.path, 'fix.ts'), 'x\n');
    const release = await p.release({ runId, outcome: 'completed', summary: 's', agentName: 'a' });
    expect(release.published.kind).toBe('git');
    expect(release.pushed).toBe(true);
  });

  it('派发链路端到端：Run 拿到真实工作目录', async () => {
    const p = new WorkspaceService(db, { root });
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
    expect(dispatched?.workspace?.vcs?.repoRef).toBe('order-service');
  });

  it('git 不可用时给出可行动的报错，而不是留下半个工作区', async () => {
    const p = new WorkspaceService(db, { root });
    await registerRepo({ ref: 'ghost', remoteUrl: join(root, 'does-not-exist.git') });

    const { runId, result } = await acquireFor(p, scopes('write', 'ghost'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('准备工作区失败');

    await expect(stat(join(root, 'runs', runId))).rejects.toThrow();
  });
});

/**
 * 产出交货到哪 —— 由登记上的 deliveryTargetId 决定，而不是只能由主挂载推断。
 *
 * ★★ 这一组兑现的是抽象里「铺料与交货两头独立可选」那半边。
 *   在 deliveryTargetId 出现之前，一个 git 主挂载的产出只能推分支，
 *   「从 Git 拉代码、把生成的报告投递到别处」表达不了 —— 而那正是
 *   docs/tech/11 §2 用来说明这个设计的例子。
 */
describe.skipIf(!gitReady.ok)('产出交货目标', () => {
  async function registerTarget(over: Partial<typeof storageTargets.$inferInsert> = {}) {
    const [row] = await db
      .insert(storageTargets)
      .values({
        orgId: fx.orgId,
        ref: 'reports',
        name: '报告归档',
        kind: 'local',
        rootPath: join(root, 'delivered'),
        writable: true,
        createdBy: fx.userId,
        ...over,
      })
      .returning();
    return row!;
  }

  it('★ 配了交货目标的 git 仓库：产出投递过去，不推分支', async () => {
    const p = new WorkspaceService(db, { root });
    const target = await registerTarget();
    await registerRepo({ deliveryTargetId: target.id });

    const { runId, result } = await acquireFor(p, scopes('write'));
    if (!result.ok) throw new Error('acquire failed');
    const ws = result.workspace!;
    await writeFile(join(ws.path, 'report.md'), '# 调研结论\n');

    const release = await p.release({
      runId,
      outcome: 'completed',
      summary: '写完了',
      agentName: 'code-agent-1',
    });

    // 产出真的落到了目标目录里
    expect(await readFile(join(root, 'delivered', runId, 'report.md'), 'utf8')).toBe('# 调研结论\n');
    expect(release.published.kind).toBe('local');
    if (release.published.kind === 'local') expect(release.published.persisted).toBe(true);

    // ★ 覆盖不是追加：选了交货目标就不推分支了
    expect(release.pushed).toBe(false);
    const remoteBranches = await git.run(['branch', '--list', ws.vcs!.branch], { cwd: remote });
    expect(remoteBranches.trim()).toBe('');
  });

  it('不配交货目标时维持原样 —— 照旧推分支', async () => {
    const p = new WorkspaceService(db, { root });
    await registerRepo();

    const { runId, result } = await acquireFor(p, scopes('write'));
    if (!result.ok) throw new Error('acquire failed');
    await writeFile(join(result.workspace!.path, 'fix.ts'), 'export const a = 1;\n');

    const release = await p.release({
      runId,
      outcome: 'completed',
      summary: 's',
      agentName: 'code-agent-1',
    });
    expect(release.published.kind).toBe('git');
    expect(release.pushed).toBe(true);
  });

  /**
   * ★★ 配了却没生效时必须说出**原因**。
   *   不说的话，收尾说明与「本来就没配交货目标」一模一样 ——
   *   而这两种情况一个是配置没生效、一个是符合预期。
   */
  it('★ 目标被改成只读后，产出不投递并说明原因', async () => {
    const p = new WorkspaceService(db, { root });
    const target = await registerTarget();
    await registerRepo({ deliveryTargetId: target.id });
    // 登记之后才被改成只读（保存时那道校验拦的是保存那一刻）
    await db.update(storageTargets).set({ writable: false }).where(eq(storageTargets.id, target.id));

    const { runId, result } = await acquireFor(p, scopes('write'));
    if (!result.ok) throw new Error('acquire failed');
    await writeFile(join(result.workspace!.path, 'report.md'), '# r\n');

    const release = await p.release({
      runId,
      outcome: 'completed',
      summary: 's',
      agentName: 'code-agent-1',
    });

    expect(release.published.kind).toBe('none');
    expect(release.note).toContain('只读');
    await expect(stat(join(root, 'delivered', runId))).rejects.toThrow();
  });

  /**
   * ★★ 投递到宿主机目录同样要过 APOS_LOCAL_MOUNT_ROOTS。
   *
   *   那道闸此前只挡「挂进来」，而「写出去」的破坏力只大不小 ——
   *   一条指向 /etc 的登记，挂进来是泄露，写出去是覆盖。
   */
  it('★ 投递路径被挂载白名单挡住时不写出去', async () => {
    const p = new WorkspaceService(db, {
      root,
      localMountRoots: [join(root, 'allowed')],
    });
    const target = await registerTarget({ rootPath: join(root, 'not-allowed') });
    await registerRepo({ deliveryTargetId: target.id });

    const { runId, result } = await acquireFor(p, scopes('write'));
    if (!result.ok) throw new Error('acquire failed');
    await writeFile(join(result.workspace!.path, 'report.md'), '# r\n');

    const release = await p.release({
      runId,
      outcome: 'completed',
      summary: 's',
      agentName: 'code-agent-1',
    });

    expect(release.published.kind).toBe('none');
    expect(release.note).toContain('APOS_LOCAL_MOUNT_ROOTS');
    await expect(stat(join(root, 'not-allowed'))).rejects.toThrow();
  });
});
