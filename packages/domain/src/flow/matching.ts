import type { RejectionCode, RejectionScope, RiskLevel, WorkItemType } from '@apos/contracts';
import { formatTokens as fmtTokens } from '../format/tokens';

/**
 * 执行主体匹配 —— 产品文档 8.3.4 / docs/tech/04-flow-engine.md §4.3
 *
 * 评分理由必须可解释：页面文档 04 §5.4 要求改派下拉展示匹配依据。
 * 一个不能解释「为什么选它」的调度器，用户不会信任它的分配结果。
 */

export interface AgentCandidate {
  id: string;
  name: string;
  type: string;
  successRate: number | null;
  sampleSize: number;
  /** 历史平均 token 用量；null = 没有样本 */
  avgTokens: number | null;
  currentLoad: number;
  maxConcurrency: number;
  tokenLimitPerRun: number | null;
  /**
   * ★★ 这个 Agent 在**目标项目**里的生效语义能力。
   *
   *   调度器与派发必须看同一份判定。此前这里读的是 agents 表上那份
   *   全组织通用的工具清单，而派发读的是另一条路径算出来的东西 ——
   *   两边给出不同答案的表现是「调度器说没有候选，真派下去其实能跑」，
   *   或者反过来。求值器（capabilities/evaluate.ts）就是为了消灭这个分歧。
   *
   * The agent's evaluated capabilities **in the target project**. Scheduler and
   * dispatch must read one verdict; two paths produce "the scheduler says no
   * candidate, yet dispatching by hand works".
   */
  capabilities: string[];
  /** 由能力翻译出来的运行时工具集 —— 只用于兼容按工具名提要求的老任务 */
  allowedTools: string[];
  deniedTools: string[];
  /** 该 Agent 是否在本项目做过同模块的任务 */
  contextAffinity: number;
  status: string;
  /**
   * 这个 Agent 是不是**本项目**的成员。
   *
   * ★★ 此前根本没有这一栏：调度器把整个组织的 Agent 都当候选
   *   （modules/agent/matching.ts 里 `eq(agents.orgId, …)`），
   *   于是一个只被加进 A 项目的 Agent 会被派去做 B 项目的任务 ——
   *   而项目是权限与上下文的边界，越过它等于把 B 的代码交给没被授权的执行体。
   *   人类那边这条线一直是有的（project_members），Agent 这边漏了。
   */
  inProject: boolean;
  /** 运行时适配器有没有在当前进程注册。没注册的话派下去也不会开始 */
  registered: boolean;
  /** 该 Agent 被授权的资源（repo / dataset 的 ref），用于比对任务所需资源 */
  resourceRefs: string[];
  /** 今日已用 token，用于日额度闸 */
  tokensToday: number | null;
  tokenLimitDaily: number | null;
}

export interface MatchTarget {
  type: WorkItemType;
  /**
   * 这活需要哪些语义能力。
   *
   * ★ 与 `requiredTools` 的关系是「新的那一栏」：按能力提要求才说得清
   *   「这活要推分支」和「这活要能改文件」的区别，而工具名说不清 ——
   *   同一个 `Bash` 在两个运行时上含义都不一样。老任务只有
   *   requiredTools，两栏都判，谁也不覆盖谁。
   */
  requiredCapabilities: string[];
  requiredTools: string[];
  estimatedTokens: number | null;
  riskLevel: RiskLevel;
  /**
   * 谁来执行。
   *
   * ★★ 取代原来的 `requiresHuman` 布尔。它把「只能人干」和「干完要人批」
   *   合成了一栏，于是「Agent 执行 + 人类审批」这种最常见的组合表达不了。
   *   审批那一半现在是工作项自己的 `approvalGate`，与匹配无关 ——
   *   匹配只回答「这活派给谁」。
   */
  executionMode: 'auto' | 'agent' | 'human';
  /** 任务要动的资源（仓库 / 数据集的 ref）。候选必须被授权过这些资源 */
  requiredResources: string[];
}

export interface MatchScore {
  agentId: string;
  agentName: string;
  score: number;
  /** 面向用户的匹配依据，直接展示 */
  reasons: string[];
}

/**
 * ★★ 原因码与层级的定义在 `@apos/contracts`，不在这里。
 *
 *   它要被前端逐条翻译并据此渲染「一键修复」按钮 —— 定义留在 domain 里的话，
 *   前端只能照抄一份枚举，而两份枚举迟早对不上（新增一个码，界面静默漏掉它）。
 *
 *   The codes live in contracts because the web app translates them and maps
 *   them to fix actions. A second copy would silently drift.
 */
export type { RejectionCode, RejectionScope } from '@apos/contracts';

export interface MatchRejection {
  agentId: string;
  agentName: string;
  /**
   * 中文兜底句 / Chinese fallback sentence.
   *
   * ★ 留着是因为日志、事件历史与老前端都在读它。新界面读 `code`。
   */
  reason: string;
  code: RejectionCode;
  scope: RejectionScope;
  /** 插值参数，键名与词条里的 `{name}` 一一对应 */
  params?: Record<string, string | number>;
}

export interface MatchResult {
  candidates: MatchScore[];
  rejected: MatchRejection[];
}

/**
 * 权重存在项目配置里，此处是默认值。上线后需用真实数据校准。
 *
 * ★★ 这里**没有** skill 这一项，而且不该再加回来。
 *
 *   评分只用得到「跑起来之后能观察到的事实」：历史成功率、项目上下文经验、
 *   当前负载、预计成本。技能标签不是事实，是一段没人维护的自述 ——
 *   Claude Code 明明写得了 TypeScript，只因为没人在它的档案里敲过
 *   「TypeScript」这个词就被排到最后，而那个词与它真实的能力毫无因果关系。
 *
 * Scoring uses only facts observable from actual runs — success rate, project
 * familiarity, current load, expected cost. Skill tags were self-declared prose
 * nobody maintained: an agent perfectly able to do the work lost to one it had
 * never done because a word was missing from a text box.
 */
export interface MatchWeights {
  successRate: number;
  contextAffinity: number;
  load: number;
  cost: number;
}

/**
 * ★ 拿掉 skill 那 0.3 之后，剩下四项按原有比例重新归一（0.25 / 0.15 / 0.15 / 0.15
 *   之和是 0.7），而不是把 0.3 平摊或者全塞给成功率 —— 归一化保持了四项之间
 *   原本的相对轻重，也让总分仍然落在 0–1 上，历史分数还能横向比。
 */
export const DEFAULT_WEIGHTS: MatchWeights = {
  successRate: 0.25 / 0.7,
  contextAffinity: 0.15 / 0.7,
  load: 0.15 / 0.7,
  cost: 0.15 / 0.7,
};

/** 样本不足时给中性值，避免新 Agent 因「没有历史成功率」被永久排除 */
const NEUTRAL_SUCCESS_RATE = 0.7;
const MIN_SAMPLE_FOR_STATS = 5;

export function matchExecutors(
  target: MatchTarget,
  candidates: AgentCandidate[],
  weights: MatchWeights = DEFAULT_WEIGHTS,
): MatchResult {
  const scores: MatchScore[] = [];
  const rejected: MatchRejection[] = [];

  if (target.executionMode === 'human') {
    return {
      candidates: [],
      rejected: candidates.map((c) => ({
        agentId: c.id,
        agentName: c.name,
        reason: '该任务被指定为人工执行',
        code: 'human_executor' as const,
        scope: 'work_item' as const,
      })),
    };
  }

  const usages = candidates.map((c) => c.avgTokens).filter((c): c is number => c !== null);
  const minTokens = usages.length ? Math.min(...usages) : 0;
  const maxTokens = usages.length ? Math.max(...usages) : 0;

  for (const agent of candidates) {
    // ── 硬性条件：不满足直接淘汰，并给出原因 ──
    /**
     * ★★ 项目成员关系排在最前面 —— 它是**授权**问题，不是匹配偏好。
     *
     *   排在能力判定后面的话，一个不属于本项目的 Agent 会先被算分、
     *   再以「技能不匹配」被拒，而真正的原因是它根本不该出现在这份名单里。
     *   拒绝理由要指向真实原因，否则用户会去给它加技能。
     */
    if (!agent.inProject) {
      rejected.push({
        agentId: agent.id,
        agentName: agent.name,
        reason: '不是本项目成员 —— 先在「成员与角色」里把它加进这个项目',
        code: 'not_project_member',
        scope: 'project',
      });
      continue;
    }
    if (agent.status !== 'active') {
      rejected.push({
        agentId: agent.id,
        agentName: agent.name,
        reason: `Agent 状态为 ${agent.status}`,
        code: 'agent_inactive',
        scope: 'org',
        params: { status: agent.status },
      });
      continue;
    }
    /** ★ 没注册的运行时派下去不会开始执行，表现是任务卡在 executing 直到超时 */
    if (!agent.registered) {
      rejected.push({
        agentId: agent.id,
        agentName: agent.name,
        reason: '运行时适配器没有在当前进程注册，派下去不会开始执行',
        code: 'runtime_not_registered',
        scope: 'platform',
      });
      continue;
    }
    /**
     * ★★ 这里**曾经**卡一道 `applicableTypes.includes(target.type)`。
     *
     *   它是「零配置接入」要拆掉的第一根钉子：那一栏的空数组含义是
     *   「什么活都不接」，而建 Agent 时它默认就是空的 —— 于是新建出来的
     *   Agent 永远接不到工作，界面上却哪儿都不红。承接范围现在不再由
     *   Agent 自己声明：普通任务由调度器从可用 Agent 里挑，特殊职责
     *   （planner / reviewer / policy manager）由项目的 Agent 绑定指定。
     *
     *   The `applicableTypes` gate is gone. An empty array meant "takes no work
     *   at all" and was the creation-time default, so every freshly created
     *   agent was silently unemployable. What an agent takes on is now decided
     *   by the scheduler (ordinary work) or by a project role binding (special
     *   duties) — never by a tag on the agent's own profile.
     */
    if (agent.currentLoad >= agent.maxConcurrency) {
      rejected.push({
        agentId: agent.id,
        agentName: agent.name,
        reason: `已满载（${agent.currentLoad}/${agent.maxConcurrency}）`,
        code: 'at_capacity',
        scope: 'org',
        params: { load: agent.currentLoad, max: agent.maxConcurrency },
      });
      continue;
    }

    /**
     * ★ 能力先判、工具后判。能力是稳定说法，工具名是运行时词汇 ——
     *   先给出能力这一侧的拒绝理由，用户拿到的是「它没有推送权限」
     *   而不是「它缺少 Bash(git push:*)」。
     */
    const missingCapabilities = target.requiredCapabilities.filter(
      (c) => !agent.capabilities.includes(c),
    );
    if (missingCapabilities.length > 0) {
      rejected.push({
        agentId: agent.id,
        agentName: agent.name,
        reason: `在这个项目里没有所需能力：${missingCapabilities.join('、')}`,
        code: 'missing_capabilities',
        scope: 'project',
        params: { items: missingCapabilities.join(', ') },
      });
      continue;
    }

    const missingTools = target.requiredTools.filter(
      (t) => agent.deniedTools.includes(t) || !agent.allowedTools.includes(t),
    );
    if (missingTools.length > 0) {
      rejected.push({
        agentId: agent.id,
        agentName: agent.name,
        reason: `缺少所需工具权限：${missingTools.join('、')}`,
        code: 'missing_tools',
        scope: 'project',
        params: { items: missingTools.join(', ') },
      });
      continue;
    }

    /**
     * ★★ 资源范围要在**派发前**判，不能等运行时报错。
     *
     *   没授权就派下去，Agent 会在准备工作区那一步失败，而那条报错说的是
     *   「挂载失败」——它不指向「这个 Agent 没被授权这个仓库」，
     *   于是排查方向直接跑偏到工作区配置上去了。
     */
    const missingResources = target.requiredResources.filter(
      (r) => !agent.resourceRefs.includes(r),
    );
    if (missingResources.length > 0) {
      rejected.push({
        agentId: agent.id,
        agentName: agent.name,
        reason: `资源范围里没有：${missingResources.join('、')}`,
        code: 'missing_resources',
        scope: 'project',
        params: { items: missingResources.join(', ') },
      });
      continue;
    }

    /** ★ 日额度是硬闸：跑到一半被扣停留下的是半成品，不如一开始就不派 */
    if (
      agent.tokenLimitDaily !== null &&
      agent.tokensToday !== null &&
      agent.tokensToday >= agent.tokenLimitDaily
    ) {
      rejected.push({
        agentId: agent.id,
        agentName: agent.name,
        reason: `今日 token 额度已用尽（${fmtTokens(agent.tokensToday)}/${fmtTokens(agent.tokenLimitDaily)}）`,
        code: 'daily_token_exhausted',
        scope: 'org',
        params: { used: fmtTokens(agent.tokensToday), limit: fmtTokens(agent.tokenLimitDaily) },
      });
      continue;
    }

    if (
      target.estimatedTokens !== null &&
      agent.tokenLimitPerRun !== null &&
      target.estimatedTokens > agent.tokenLimitPerRun
    ) {
      rejected.push({
        agentId: agent.id,
        agentName: agent.name,
        reason: `预估 ${fmtTokens(target.estimatedTokens)} token 超出该 Agent 单次上限 ${fmtTokens(agent.tokenLimitPerRun)}`,
        code: 'per_run_token_exceeded',
        scope: 'org',
        params: {
          estimated: fmtTokens(target.estimatedTokens),
          limit: fmtTokens(agent.tokenLimitPerRun),
        },
      });
      continue;
    }

    // ── 加权评分 ──
    const hasStats = agent.sampleSize >= MIN_SAMPLE_FOR_STATS && agent.successRate !== null;
    const successRate = hasStats ? agent.successRate! : NEUTRAL_SUCCESS_RATE;
    const loadFactor = 1 - agent.currentLoad / agent.maxConcurrency;
    const costFactor =
      agent.avgTokens === null || maxTokens === minTokens
        ? 0.5
        : 1 - (agent.avgTokens - minTokens) / (maxTokens - minTokens);

    const score =
      weights.successRate * successRate +
      weights.contextAffinity * agent.contextAffinity +
      weights.load * loadFactor +
      weights.cost * costFactor;

    const reasons = [
      hasStats
        ? `历史成功率 ${Math.round(successRate * 100)}%（${agent.sampleSize} 次）`
        : `样本不足（${agent.sampleSize} 次），按中性值 ${Math.round(NEUTRAL_SUCCESS_RATE * 100)}% 计`,
      `当前负载 ${agent.currentLoad}/${agent.maxConcurrency}`,
    ];
    if (agent.avgTokens !== null) reasons.push(`平均 ${fmtTokens(agent.avgTokens)} token/任务`);
    if (agent.contextAffinity > 0.5) reasons.push('做过本项目同类任务');

    scores.push({ agentId: agent.id, agentName: agent.name, score, reasons });
  }

  scores.sort((a, b) => b.score - a.score);
  return { candidates: scores, rejected };
}
