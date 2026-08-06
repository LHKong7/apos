import type { Condition, FactKey, Policy, PolicyContext } from '@apos/contracts';
import { isAutoApprove, matchCondition } from './evaluate';

/**
 * Policy 模拟回放 —— 页面文档 13 §5.7 / docs/tech/05-policy-engine.md §5
 *
 * 这是让用户敢于放开自动化的关键功能：把草稿规则拿到历史数据上跑，
 * 看会自动处理多少次、其中多少次与人类当时的判断不一致。
 */

export interface HistoricalSample {
  eventId: string;
  workItemId: string;
  occurredAt: string;
  context: PolicyContext;
  /** 当时人类的决策结果；null 表示当时未走人工 */
  humanDecision: 'approved' | 'rejected' | 'revision_requested' | null;
  humanNote: string | null;
  workItemTitle: string;
}

export interface Mismatch {
  eventId: string;
  workItemId: string;
  occurredAt: string;
  workItemTitle: string;
  humanDecision: string;
  humanNote: string | null;
  context: PolicyContext;
}

export interface Suggestion {
  addCondition: { fact: FactKey; op: 'ne' | 'not_in'; value: unknown };
  rationale: string;
  wouldEliminate: number;
}

export interface SimulationResult {
  totalSamples: number;
  /** 不一致的评估次数。mismatches 已按任务去重，两者对不上是正常的 */
  mismatchEvaluations: number;
  /** 草稿规则引用的 fact 在快照中缺失，无法评估的样本数 */
  skippedForMissingFacts: number;
  evaluatedSamples: number;
  wouldAutoHandle: number;
  mismatches: Mismatch[];
  suggestions: Suggestion[];
  confidence: 'high' | 'medium' | 'low';
  /** 必须向用户说明的局限 */
  caveats: string[];
}

/** 提取条件树中引用的所有 fact */
export function requiredFacts(cond: Condition): FactKey[] {
  if ('all' in cond) return cond.all.flatMap(requiredFacts);
  if ('any' in cond) return cond.any.flatMap(requiredFacts);
  if ('not' in cond) return requiredFacts(cond.not);
  return [cond.fact];
}

function hasAllFacts(ctx: PolicyContext, facts: FactKey[]): boolean {
  return facts.every((f) => ctx[f] !== undefined);
}

function mode<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/**
 * 从不一致案例推导条件补充建议。
 *
 * ⚠ 这是统计启发，不是因果推断。结果必须标注「基于 N 个案例的模式，
 *   请人工确认是否合理」，绝不自动应用。
 */
export function deriveSuggestions(
  mismatches: Mismatch[],
  consistent: HistoricalSample[],
  facts: FactKey[],
): Suggestion[] {
  if (mismatches.length === 0) return [];

  const CANDIDATE_FACTS: FactKey[] = [
    'operationType',
    'environment',
    'externalFacing',
    'dataSensitivity',
    'workItemType',
    'reversible',
    'projectType',
  ];

  const suggestions: Suggestion[] = [];

  for (const fact of CANDIDATE_FACTS) {
    // 已经在条件里的 fact 不再建议
    if (facts.includes(fact)) continue;

    const mismatchValues = mismatches.map((m) => m.context[fact]);
    const okValues = consistent.map((s) => s.context[fact]);

    const dominant = mode(mismatchValues);
    if (dominant === undefined || dominant === null) continue;

    const hits = mismatchValues.filter((v) => v === dominant).length;
    const concentration = hits / mismatchValues.length;
    const baseRate =
      okValues.length === 0 ? 0 : okValues.filter((v) => v === dominant).length / okValues.length;

    // 该取值在不一致样本中高度集中，且在一致样本中罕见
    if (concentration >= 0.8 && baseRate < 0.2) {
      suggestions.push({
        addCondition: { fact, op: 'ne', value: dominant },
        rationale: `${hits} 个不一致案例的「${fact}」都是 ${String(dominant)}`,
        wouldEliminate: hits,
      });
    }
  }

  return suggestions.sort((a, b) => b.wouldEliminate - a.wouldEliminate);
}

export function simulate(draft: Pick<Policy, 'condition' | 'action'>, samples: HistoricalSample[]): SimulationResult {
  const facts = [...new Set(requiredFacts(draft.condition))];
  const caveats: string[] = [];

  let skipped = 0;
  const applicable: HistoricalSample[] = [];

  for (const sample of samples) {
    if (!hasAllFacts(sample.context, facts)) {
      skipped++;
      continue;
    }
    if (matchCondition(draft.condition, sample.context).matched) {
      applicable.push(sample);
    }
  }

  const evaluated = samples.length - skipped;
  const draftAutoApproves = isAutoApprove(draft.action);

  const disagreeing = draftAutoApproves
    ? applicable.filter(
        (s) => s.humanDecision === 'rejected' || s.humanDecision === 'revision_requested',
      )
    : [];

  /**
   * ★ 按任务去重。
   *   一个任务在生命周期里会被评估很多次，每次都产生一个样本；
   *   不去重的话「发现 10 处不一致」实际只是 4 个任务被数了两三遍。
   *   用户点进去会发现同一张卡片出现三次，然后就再也不信这个数字了。
   */
  const seenItems = new Set<string>();
  const mismatches: Mismatch[] = [];
  for (const s of disagreeing) {
    if (seenItems.has(s.workItemId)) continue;
    seenItems.add(s.workItemId);
    mismatches.push({
      eventId: s.eventId,
      workItemId: s.workItemId,
      occurredAt: s.occurredAt,
      workItemTitle: s.workItemTitle,
      humanDecision: s.humanDecision as string,
      humanNote: s.humanNote,
      context: s.context,
    });
  }

  const consistent = applicable.filter((s) => !seenItems.has(s.workItemId));

  // 诚实性：必须告知局限（docs/tech/05-policy-engine.md §5.3）
  if (samples.length < 20) {
    caveats.push(`样本量较小（N=${samples.length}），结果仅供参考`);
  }
  if (skipped > 0) {
    caveats.push(`${skipped} 个历史样本缺少条件所需数据，未纳入模拟`);
  }
  if (skipped > evaluated) {
    caveats.push('超过半数样本无法评估，模拟结果不足以作为决策依据');
  }
  if (mismatches.length === 0 && applicable.length > 0 && applicable.length < 10) {
    caveats.push('在有限样本中未发现不一致，但样本不足以证明无风险');
  }

  const confidence: SimulationResult['confidence'] =
    evaluated >= 50 && skipped <= evaluated * 0.2
      ? 'high'
      : evaluated >= 20
        ? 'medium'
        : 'low';

  return {
    totalSamples: samples.length,
    mismatchEvaluations: disagreeing.length,
    skippedForMissingFacts: skipped,
    evaluatedSamples: evaluated,
    wouldAutoHandle: applicable.length,
    mismatches,
    suggestions: deriveSuggestions(mismatches, consistent, facts),
    confidence,
    caveats,
  };
}
