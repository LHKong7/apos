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

  it('没有工作区时整段省略', () => {
    const text = buildGovernanceRules(task(null), { writable: false });
    expect(text).not.toContain('工作区：');
  });
});
