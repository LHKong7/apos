import { describe, expect, it } from 'vitest';
import type { RunWorkspace, TaskDispatch } from '@apos/contracts';
import { buildGovernanceRules } from './prompt';

function task(workspace: RunWorkspace | null): TaskDispatch {
  return {
    runId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'wi-1:1',
    agent: { name: 'a', type: 'code', description: null, skills: [] },
    workspace,
    goal: { title: 't', description: 'd', acceptanceCriteria: [], constraints: [] },
    context: [],
    permissions: { allowedTools: ['Read'], deniedTools: [], resourceScopes: [] },
    limits: { maxCostUsd: 5, maxDurationSeconds: 600, maxTokens: null },
    model: null,
    callback: { eventsUrl: '/x', token: 't' },
  };
}

describe('治理规则里的工作区说明', () => {
  it('有版本控制时说清分支与基线，并禁止 Agent 自行提交', () => {
    const text = buildGovernanceRules(
      task({
        path: '/tmp/ws/order-service',
        writable: true,
        additionalPaths: [],
        vcs: {
          repoRef: 'order-service',
          branch: 'apos/fix-a1b2c3d4',
          baseBranch: 'main',
          baseCommit: 'abc123',
        },
      }),
      { writable: true },
    );

    expect(text).toContain('apos/fix-a1b2c3d4');
    expect(text).toContain('基于 main');
    expect(text).toContain('不要 push');
  });

  /**
   * ★ 这条盯的是一个真实存在过的现象：规划任务的工作区曾经用
   *   repoRef:'planning' / branch:'planning' 占位，于是 prompt 会生成
   *   「你在分支 planning 上工作，它基于 planning」下发给 Agent ——
   *   一句纯粹的胡话，Agent 读到只会去找一个不存在的分支。
   */
  it('没有版本控制时不提分支，如实说这是普通目录', () => {
    const text = buildGovernanceRules(
      task({ path: '/tmp/ws/planning/r1', writable: true, additionalPaths: [], vcs: null }),
      { writable: true },
    );

    expect(text).toContain('/tmp/ws/planning/r1');
    expect(text).toContain('不在版本控制下');
    expect(text).not.toContain('分支');
  });

  /**
   * ★★ 挂了参考目录却不写进 prompt，等于没挂。
   *
   *   规划 Run 现在会把项目代码只读挂进来（acquireLocal 的 readOnly）。
   *   如果 prompt 不说它在哪，Agent 不知道有这么个目录 —— 表现与
   *   「根本没挂」一模一样：照样只凭需求原文编，而工作区里躺着整个仓库。
   */
  it('★ 有只读参考目录时要在 prompt 里点名路径，并说明不可修改', () => {
    const text = buildGovernanceRules(
      task({
        path: '/tmp/ws/planning/r1',
        writable: true,
        additionalPaths: ['/tmp/ws/runs/r1/order-service', '/tmp/ws/runs/r1/datasets'],
        vcs: null,
      }),
      { writable: true },
    );

    expect(text).toContain('/tmp/ws/runs/r1/order-service');
    expect(text).toContain('/tmp/ws/runs/r1/datasets');
    expect(text).toContain('只读');
    expect(text).toContain('不要修改');
  });

  it('没有参考目录时不出现那一段', () => {
    const text = buildGovernanceRules(
      task({ path: '/tmp/ws/planning/r1', writable: true, additionalPaths: [], vcs: null }),
      { writable: true },
    );
    expect(text).not.toContain('参考资料');
  });

  it('没有工作区时整段省略', () => {
    const text = buildGovernanceRules(task(null), { writable: false });
    expect(text).not.toContain('工作区：');
  });
});
