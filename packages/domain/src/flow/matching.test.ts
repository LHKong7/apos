import { describe, expect, it } from 'vitest';
import { matchExecutors, type AgentCandidate, type MatchTarget } from './matching';

/**
 * 执行主体匹配。
 *
 * ★★ 这组测试的重点是**拒绝理由**，不只是「选中了谁」。
 *
 *   页面文档 04 §5.4 要求改派下拉展示匹配依据，而用户真正卡住的时候
 *   要看的是反面：为什么这个 Agent 不在列表里。理由错了比没有更糟 ——
 *   一个因为「不是项目成员」被拒的 Agent，如果报成「技能不匹配」，
 *   用户会去给它加技能，加完还是不行。
 */

const agent = (over: Partial<AgentCandidate> = {}): AgentCandidate => ({
  id: 'a1',
  name: 'coder',
  type: 'code',
  skills: ['typescript'],
  applicableTypes: ['task'],
  successRate: 0.9,
  sampleSize: 10,
  avgTokens: 1,
  currentLoad: 0,
  maxConcurrency: 3,
  tokenLimitPerRun: null,
  capabilities: ['workspace.read', 'workspace.write'],
  allowedTools: ['Read', 'Edit'],
  deniedTools: [],
  contextAffinity: 0.5,
  status: 'active',
  inProject: true,
  registered: true,
  resourceRefs: ['order-service'],
  tokensToday: 0,
  tokenLimitDaily: null,
  ...over,
});

const target = (over: Partial<MatchTarget> = {}): MatchTarget => ({
  type: 'task',
  requiredSkills: [],
  requiredCapabilities: [],
  requiredTools: [],
  estimatedTokens: null,
  riskLevel: 'low',
  executionMode: 'auto',
  requiredResources: [],
  ...over,
});

const reasonFor = (result: ReturnType<typeof matchExecutors>, id = 'a1') =>
  result.rejected.find((r) => r.agentId === id)?.reason ?? '';

describe('执行主体匹配', () => {
  it('满足全部硬条件的 Agent 进候选并带上匹配依据', () => {
    const result = matchExecutors(target(), [agent()]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.agentId).toBe('a1');
    expect(result.candidates[0]!.reasons.length).toBeGreaterThan(0);
  });

  /**
   * ★★ 这一条是这次修复的核心。
   *
   *   在它之前，调度器的候选来自**整个组织**（`eq(agents.orgId, …)`），
   *   于是一个只被加进 A 项目的 Agent 会被派去做 B 项目的任务。
   *   项目是权限与上下文的边界，人类那边一直靠 project_members 守着，
   *   Agent 这边整整漏了一层。
   */
  it('★ 不是本项目成员的 Agent 一律不进候选', () => {
    const result = matchExecutors(target(), [agent({ inProject: false })]);
    expect(result.candidates).toHaveLength(0);
    expect(reasonFor(result)).toContain('不是本项目成员');
  });

  /**
   * ★ 成员关系要**排在能力判定之前**。排后面的话，一个不属于本项目的
   *   Agent 会先被算分、再以「技能不匹配」被拒 —— 用户照着那条理由
   *   去加技能，加完还是不行，而真正的原因从没显示出来。
   */
  it('★ 既不是成员又不适用该类型时，报的是成员关系', () => {
    const result = matchExecutors(
      target({ type: 'bug' }),
      [agent({ inProject: false, applicableTypes: ['task'] })],
    );
    expect(reasonFor(result)).toContain('不是本项目成员');
    expect(reasonFor(result)).not.toContain('不适用');
  });

  it('★ 运行时没注册的 Agent 不进候选 —— 派下去只会卡到超时', () => {
    const result = matchExecutors(target(), [agent({ registered: false })]);
    expect(result.candidates).toHaveLength(0);
    expect(reasonFor(result)).toContain('没有在当前进程注册');
  });

  /**
   * ★ 资源范围要在派发前判。没授权就派下去，失败发生在准备工作区那一步，
   *   而那条报错说的是「挂载失败」—— 指不到「这个 Agent 没被授权这个仓库」。
   */
  it('★ 资源范围里没有目标资源的 Agent 不进候选，且理由点名缺哪个', () => {
    const result = matchExecutors(
      target({ requiredResources: ['payments-api'] }),
      [agent({ resourceRefs: ['order-service'] })],
    );
    expect(result.candidates).toHaveLength(0);
    expect(reasonFor(result)).toContain('payments-api');
  });

  it('资源范围覆盖得上就正常进候选', () => {
    const result = matchExecutors(
      target({ requiredResources: ['order-service'] }),
      [agent({ resourceRefs: ['order-service', 'docs'] })],
    );
    expect(result.candidates).toHaveLength(1);
  });

  it('★ 日 token 额度用尽的 Agent 不进候选 —— 跑到一半被扣停留下的是半成品', () => {
    const result = matchExecutors(
      target(),
      [agent({ tokensToday: 120_000, tokenLimitDaily: 100_000 })],
    );
    expect(result.candidates).toHaveLength(0);
    expect(reasonFor(result)).toContain('今日 token 额度已用尽');
  });

  it('日额度没设时不因为用量被拒', () => {
    const result = matchExecutors(
      target(),
      [agent({ tokensToday: 9_999_999, tokenLimitDaily: null })],
    );
    expect(result.candidates).toHaveLength(1);
  });

  it('预估 token 超出单次上限的 Agent 不进候选，理由里带上两个数', () => {
    const result = matchExecutors(
      target({ estimatedTokens: 500_000 }),
      [agent({ tokenLimitPerRun: 200_000 })],
    );
    expect(result.candidates).toHaveLength(0);
    expect(reasonFor(result)).toContain('500k');
    expect(reasonFor(result)).toContain('200k');
  });

  it('预估 token 在单次上限之内时正常进候选', () => {
    const result = matchExecutors(
      target({ estimatedTokens: 150_000 }),
      [agent({ tokenLimitPerRun: 200_000 })],
    );
    expect(result.candidates).toHaveLength(1);
  });

  /**
   * ★ 迁移把所有用户配过的上限都清空了（migrations/0028），
   *   所以「上限为 null」是升级后的**普遍**状态，不是边缘情况。
   *   这条要是错了，升级当天全组织的派发都会停。
   */
  it('单次上限为 null 时不拦 —— 迁移后所有 Agent 都是这个状态', () => {
    const result = matchExecutors(
      target({ estimatedTokens: 9_999_999 }),
      [agent({ tokenLimitPerRun: null })],
    );
    expect(result.candidates).toHaveLength(1);
  });

  /**
   * ★★ executionMode 取代了原来的 requiresHuman。
   *
   *   拆分的理由是「只能人干」与「干完要人批」正交：后者现在是工作项自己的
   *   approvalGate，与匹配无关。匹配只回答「这活派给谁」。
   */
  it('★ executionMode=human 时所有 Agent 都被排除', () => {
    const result = matchExecutors(target({ executionMode: 'human' }), [agent()]);
    expect(result.candidates).toHaveLength(0);
    expect(reasonFor(result)).toContain('人工执行');
  });

  it('executionMode=agent 与 auto 都参与匹配', () => {
    for (const mode of ['agent', 'auto'] as const) {
      const result = matchExecutors(target({ executionMode: mode }), [agent()]);
      expect(result.candidates, mode).toHaveLength(1);
    }
  });

  it('满载、停用、缺工具权限各自给出可读的理由', () => {
    expect(reasonFor(matchExecutors(target(), [agent({ currentLoad: 3, maxConcurrency: 3 })])))
      .toContain('已满载');
    expect(reasonFor(matchExecutors(target(), [agent({ status: 'paused' })])))
      .toContain('paused');
    expect(
      reasonFor(
        matchExecutors(target({ requiredTools: ['Bash'] }), [agent({ allowedTools: ['Read'] })]),
      ),
    ).toContain('Bash');
  });

  it('★ 每个被拒的 Agent 都要有理由 —— 空理由等于没解释', () => {
    const all = matchExecutors(
      target({ requiredResources: ['x'], requiredTools: ['Bash'] }),
      [
        agent({ id: 'a1', inProject: false }),
        agent({ id: 'a2', registered: false }),
        agent({ id: 'a3', status: 'paused' }),
        agent({ id: 'a4', currentLoad: 9 }),
        agent({ id: 'a5' }),
      ],
    );
    expect(all.rejected).toHaveLength(5);
    for (const r of all.rejected) expect(r.reason.trim()).not.toBe('');
  });
});
