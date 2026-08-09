import type { RiskLevel, WorkItemType } from '@apos/contracts';

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
  skills: string[];
  applicableTypes: WorkItemType[];
  successRate: number | null;
  sampleSize: number;
  avgCost: number | null;
  currentLoad: number;
  maxConcurrency: number;
  costLimitPerRun: number | null;
  allowedTools: string[];
  deniedTools: string[];
  /** 该 Agent 是否在本项目做过同模块的任务 */
  contextAffinity: number;
  status: string;
}

export interface MatchTarget {
  type: WorkItemType;
  requiredSkills: string[];
  requiredTools: string[];
  estimatedCost: number | null;
  riskLevel: RiskLevel;
  /** 计划阶段标记为需要人类经验的任务不参与 Agent 匹配 */
  requiresHuman: boolean;
}

export interface MatchScore {
  agentId: string;
  agentName: string;
  score: number;
  /** 面向用户的匹配依据，直接展示 */
  reasons: string[];
}

export interface MatchRejection {
  agentId: string;
  agentName: string;
  reason: string;
}

export interface MatchResult {
  candidates: MatchScore[];
  rejected: MatchRejection[];
}

/** 权重存在项目配置里，此处是默认值。上线后需用真实数据校准。 */
export interface MatchWeights {
  skill: number;
  successRate: number;
  contextAffinity: number;
  load: number;
  cost: number;
}

export const DEFAULT_WEIGHTS: MatchWeights = {
  skill: 0.3,
  successRate: 0.25,
  contextAffinity: 0.15,
  load: 0.15,
  cost: 0.15,
};

/** 样本不足时给中性值，避免新 Agent 因「没有历史成功率」被永久排除 */
const NEUTRAL_SUCCESS_RATE = 0.7;
const MIN_SAMPLE_FOR_STATS = 5;

function jaccard(a: string[], b: string[]): number {
  if (b.length === 0) return 1; // 任务没有技能要求时不因此扣分
  const setA = new Set(a);
  const hit = b.filter((s) => setA.has(s));
  const union = new Set([...a, ...b]);
  return union.size === 0 ? 1 : hit.length / b.length;
}

export function matchExecutors(
  target: MatchTarget,
  candidates: AgentCandidate[],
  weights: MatchWeights = DEFAULT_WEIGHTS,
): MatchResult {
  const scores: MatchScore[] = [];
  const rejected: MatchRejection[] = [];

  if (target.requiresHuman) {
    return {
      candidates: [],
      rejected: candidates.map((c) => ({
        agentId: c.id,
        agentName: c.name,
        reason: '该任务在计划中被标记为需要人类经验',
      })),
    };
  }

  const costs = candidates.map((c) => c.avgCost).filter((c): c is number => c !== null);
  const minCost = costs.length ? Math.min(...costs) : 0;
  const maxCost = costs.length ? Math.max(...costs) : 0;

  for (const agent of candidates) {
    // ── 硬性条件：不满足直接淘汰，并给出原因 ──
    if (agent.status !== 'active') {
      rejected.push({ agentId: agent.id, agentName: agent.name, reason: `Agent 状态为 ${agent.status}` });
      continue;
    }
    if (!agent.applicableTypes.includes(target.type)) {
      rejected.push({
        agentId: agent.id,
        agentName: agent.name,
        reason: `不适用于 ${target.type} 类型任务`,
      });
      continue;
    }
    if (agent.currentLoad >= agent.maxConcurrency) {
      rejected.push({
        agentId: agent.id,
        agentName: agent.name,
        reason: `已满载（${agent.currentLoad}/${agent.maxConcurrency}）`,
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
      });
      continue;
    }

    if (
      target.estimatedCost !== null &&
      agent.costLimitPerRun !== null &&
      target.estimatedCost > agent.costLimitPerRun
    ) {
      rejected.push({
        agentId: agent.id,
        agentName: agent.name,
        reason: `预估成本 $${target.estimatedCost} 超出该 Agent 单次上限 $${agent.costLimitPerRun}`,
      });
      continue;
    }

    // ── 加权评分 ──
    const skillMatch = jaccard(agent.skills, target.requiredSkills);
    const hasStats = agent.sampleSize >= MIN_SAMPLE_FOR_STATS && agent.successRate !== null;
    const successRate = hasStats ? agent.successRate! : NEUTRAL_SUCCESS_RATE;
    const loadFactor = 1 - agent.currentLoad / agent.maxConcurrency;
    const costFactor =
      agent.avgCost === null || maxCost === minCost
        ? 0.5
        : 1 - (agent.avgCost - minCost) / (maxCost - minCost);

    const score =
      weights.skill * skillMatch +
      weights.successRate * successRate +
      weights.contextAffinity * agent.contextAffinity +
      weights.load * loadFactor +
      weights.cost * costFactor;

    const matched = target.requiredSkills.filter((s) => agent.skills.includes(s));
    const reasons = [
      target.requiredSkills.length > 0
        ? `Skill 匹配 ${Math.round(skillMatch * 100)}%（${matched.join('、') || '无重合'}）`
        : 'Skill 无特定要求',
      hasStats
        ? `历史成功率 ${Math.round(successRate * 100)}%（${agent.sampleSize} 次）`
        : `样本不足（${agent.sampleSize} 次），按中性值 ${Math.round(NEUTRAL_SUCCESS_RATE * 100)}% 计`,
      `当前负载 ${agent.currentLoad}/${agent.maxConcurrency}`,
    ];
    if (agent.avgCost !== null) reasons.push(`平均成本 $${agent.avgCost.toFixed(2)}/任务`);
    if (agent.contextAffinity > 0.5) reasons.push('做过本项目同类任务');

    scores.push({ agentId: agent.id, agentName: agent.name, score, reasons });
  }

  scores.sort((a, b) => b.score - a.score);
  return { candidates: scores, rejected };
}
