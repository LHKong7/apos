import { eq } from 'drizzle-orm';
import {
  requirementAssumptions,
  requirementClarifications,
  requirements,
  type Database,
} from '@apos/db';
import { humanActor, SYSTEM_ACTOR, type ActorRef } from '@apos/contracts';
import { emitAndPublish } from '../event/bus';
import type { PlanningProvider } from '../planning/provider';

/** 需求完整度六维评分（产品文档 8.2.3） */
export interface Completeness {
  goal: number;
  scope: number;
  acceptance: number;
  dependency: number;
  risk: number;
  technical: number;
  total: number;
}

const DIMENSIONS = ['goal', 'scope', 'acceptance', 'dependency', 'risk', 'technical'] as const;

/**
 * 这条需求有没有结构化内容 —— 不管它是 AI 分析出来的还是人工填的。
 *
 * ★★ 判据只看**内容**，不看来源。
 *
 *   AI 分析与人工填写是并行的两条路：有人愿意先让 Agent 出稿再改，
 *   也有人（尤其是需求本来就写得很清楚、或者压根没配规划 Agent 时）
 *   直接自己填。按「分析过没有」设闸门，等于把后一条路堵死 ——
 *   而这条路是产品文档 03 §7「分析超时 → 取消并转人工填写」的出路。
 *
 * ★ 三选一而不是全都要：这里只是「不是一张白纸」的下限。
 *   够不够详细由完整度评分说，那是给人看的建议，不是闸门。
 */
export function hasStructuredContent(req: {
  title: string | null;
  businessGoal: string | null;
  acceptanceCriteria: unknown[];
}): boolean {
  return Boolean(
    req.title?.trim() || req.businessGoal?.trim() || (req.acceptanceCriteria?.length ?? 0) > 0,
  );
}

export function scoreCompleteness(req: {
  businessGoal: string | null;
  scope: Record<string, unknown>;
  acceptanceCriteria: unknown[];
  risks: unknown[];
  businessContext: string | null;
  unansweredMustConfirm: number;
}): Completeness {
  const inScope = (req.scope['inScope'] as unknown[] | undefined) ?? [];
  const outOfScope = (req.scope['outOfScope'] as unknown[] | undefined) ?? [];

  const scores = {
    goal: req.businessGoal ? 100 : 0,
    scope: Math.min(100, inScope.length * 40 + outOfScope.length * 20),
    acceptance: Math.min(100, req.acceptanceCriteria.length * 34),
    // 未回答的必答问题直接压低依赖明确度 —— 它们通常就是依赖不清导致的
    dependency: Math.max(0, 100 - req.unansweredMustConfirm * 30),
    risk: req.risks.length > 0 ? 100 : 40,
    technical: req.businessContext && req.businessContext.length > 50 ? 80 : 40,
  };

  const total = Math.round(DIMENSIONS.reduce((sum, d) => sum + scores[d], 0) / DIMENSIONS.length);
  return { ...scores, total };
}

export interface AnalyzeResult {
  requirementId: string;
  completeness: Completeness;
  clarificationCount: number;
  mustConfirmCount: number;
  cost: number;
  /** 因为是人改过的而被保留、没有被这一轮分析覆盖的字段 */
  keptHumanFields: string[];
}

/** 结构化字段一览 —— 分析要写的、人工能改的，就是这些 */
const STRUCTURED_FIELDS = [
  'title',
  'businessContext',
  'userProblem',
  'businessGoal',
  'userStories',
  'scope',
  'nonFunctional',
  'successMetrics',
  'constraints',
  'risks',
  'acceptanceCriteria',
] as const;

/**
 * 这个字段现在是不是人改过的。
 *
 * ★★ 人改过的字段，重新分析不覆盖（产品文档 03 §9「人类编辑中的字段不被
 *   AI 重新分析覆盖」）。
 *
 *   不这么做的话，「AI 与人工同时支持」就只是并列摆着两个入口：人辛苦
 *   改完的措辞，被同事随手点一次「重新分析」就静默清掉了 —— 页面上没有
 *   任何迹象，而他下次看到的是一份自己没写过、却署着自己名字的需求。
 */
function isHumanWritten(provenance: Record<string, unknown>, field: string): boolean {
  return (provenance[field] as { source?: string } | undefined)?.source === 'human';
}

/**
 * AI 需求结构化（产品文档 8.2.2）。
 *
 * 原文永不覆盖 —— 用户必须能验证 AI 没有曲解自己的意思。
 */
export async function analyzeRequirement(
  db: Database,
  provider: PlanningProvider,
  input: { requirementId: string; correlationId: string; actor?: ActorRef },
): Promise<AnalyzeResult> {
  const [req] = await db
    .select()
    .from(requirements)
    .where(eq(requirements.id, input.requirementId));
  if (!req) throw new Error(`需求不存在: ${input.requirementId}`);

  await db
    .update(requirements)
    .set({ status: 'analyzing' })
    .where(eq(requirements.id, req.id));

  const structured = await provider.structureRequirement({
    rawInput: req.rawInput,
    projectType: 'development',
    context: [],
    // 走真实 Agent 的 provider 靠它挑执行者（组织内 applicableTypes 含 requirement 的 Agent）
    scope: { orgId: req.orgId, projectId: req.projectId },
  });

  // 清掉上一轮的澄清问题，避免重复分析时堆积
  await db
    .delete(requirementClarifications)
    .where(eq(requirementClarifications.requirementId, req.id));

  if (structured.clarifications.length > 0) {
    await db.insert(requirementClarifications).values(
      structured.clarifications.map((c) => ({
        requirementId: req.id,
        level: c.level,
        question: c.question,
        impact: c.impact,
        agentSuggestion: c.agentSuggestion,
        suggestionBasis: c.suggestionBasis,
        options: c.options,
      })),
    );
  }

  const existingAssumptions = await db
    .select({ statement: requirementAssumptions.statement })
    .from(requirementAssumptions)
    .where(eq(requirementAssumptions.requirementId, req.id));
  const known = new Set(existingAssumptions.map((a) => a.statement));

  const fresh = structured.assumptions.filter((a) => !known.has(a));
  if (fresh.length > 0) {
    await db.insert(requirementAssumptions).values(
      fresh.map((statement) => ({
        requirementId: req.id,
        statement,
        origin: 'agent_inferred',
      })),
    );
  }

  const mustConfirm = structured.clarifications.filter((c) => c.level === 'must_confirm').length;

  /**
   * ★★ 人改过的字段保留原值，这一轮分析的结果不往上盖。
   *
   *   两条路要能真正并行，就必须有一方让步 —— 让步的只能是 AI：
   *   人改过的东西被静默覆盖，代价是他重新写一遍并且从此不敢再改；
   *   AI 的建议被挡下，代价只是他重新点一次「重新分析」前先把那个标记清掉。
   */
  const provenanceBefore = req.fieldProvenance as Record<string, unknown>;
  const analyzedValues: Record<string, unknown> = {
    title: structured.title,
    businessContext: structured.businessContext,
    userProblem: structured.userProblem,
    businessGoal: structured.businessGoal,
    userStories: structured.userStories,
    scope: structured.scope,
    nonFunctional: structured.nonFunctional,
    successMetrics: structured.successMetrics,
    constraints: structured.constraints,
    risks: structured.risks,
    acceptanceCriteria: structured.acceptanceCriteria,
  };

  const keptHumanFields = STRUCTURED_FIELDS.filter((f) => isHumanWritten(provenanceBefore, f));
  const kept = new Set<string>(keptHumanFields);
  const merged = Object.fromEntries(
    STRUCTURED_FIELDS.map((f) => [
      f,
      kept.has(f) ? (req as unknown as Record<string, unknown>)[f] : analyzedValues[f],
    ]),
  );

  // 溯源同理：保住的字段留着「人工」那条记录，其余换成这一轮的原文溯源
  const provenance: Record<string, unknown> = { ...structured.provenance };
  for (const f of kept) provenance[f] = provenanceBefore[f];

  const completeness = scoreCompleteness({
    businessGoal: merged['businessGoal'] as string | null,
    scope: merged['scope'] as Record<string, unknown>,
    acceptanceCriteria: merged['acceptanceCriteria'] as unknown[],
    risks: merged['risks'] as unknown[],
    businessContext: merged['businessContext'] as string | null,
    unansweredMustConfirm: mustConfirm,
  });

  await db
    .update(requirements)
    .set({
      status: mustConfirm > 0 ? 'clarifying' : 'awaiting_approval',
      ...merged,
      fieldProvenance: provenance,
      completeness: completeness as unknown as Record<string, unknown>,
      // ★ 记下这一轮到底是谁分析的。回退到规则占位时它会带上原因（见 agent-provider.ts）
      analysisModel: structured.model,
      updatedAt: new Date(),
    } as never)
    .where(eq(requirements.id, req.id));

  await emitAndPublish(db, {
    type: 'requirement.analyzed',
    orgId: req.orgId,
    projectId: req.projectId,
    actor: input.actor ?? SYSTEM_ACTOR,
    subjectType: 'requirement',
    subjectId: req.id,
    payload: {
      completeness,
      questionCount: structured.clarifications.length,
      mustConfirmCount: mustConfirm,
      cost: structured.cost,
      model: structured.model,
      // 保住了哪些人工字段要进审计：它解释了「为什么这一版和 AI 说的不一样」
      keptHumanFields,
    },
    correlationId: input.correlationId,
  });

  return {
    requirementId: req.id,
    completeness,
    clarificationCount: structured.clarifications.length,
    mustConfirmCount: mustConfirm,
    cost: structured.cost,
    keptHumanFields: [...keptHumanFields],
  };
}

export interface AnswerInput {
  clarificationId: string;
  answer: string;
  usedSuggestion: boolean;
  actorId: string;
  correlationId: string;
}

export async function answerClarification(db: Database, input: AnswerInput) {
  const [row] = await db
    .update(requirementClarifications)
    .set({ answer: input.answer, answeredBy: input.actorId, answeredAt: new Date() })
    .where(eq(requirementClarifications.id, input.clarificationId))
    .returning();

  if (!row) throw new Error(`澄清问题不存在: ${input.clarificationId}`);

  const [req] = await db
    .select()
    .from(requirements)
    .where(eq(requirements.id, row.requirementId));

  await emitAndPublish(db, {
    type: 'requirement.clarification_answered',
    level: 'detail',
    orgId: req!.orgId,
    projectId: req!.projectId,
    actor: humanActor(input.actorId),
    subjectType: 'requirement',
    subjectId: row.requirementId,
    payload: {
      questionId: row.id,
      level: row.level,
      usedSuggestion: input.usedSuggestion,
    },
    correlationId: input.correlationId,
  });

  await refreshCompleteness(db, row.requirementId);
  return row;
}

/**
 * 重算完整度并推进状态。
 *
 * ★★ 回答澄清问题与**人工编辑字段**走同一个函数。
 *
 *   人工编辑那条路以前不重算：一个人把业务目标、范围、验收标准全填好，
 *   完整度还停在分析那一刻的分数（没分析过就是 0），头部的六维评分与他
 *   眼前的内容完全对不上 —— 而这一页所有的「够不够格确认」的判断，
 *   用户都是照着那个分数做的。
 *
 * ★ 已确认 / 已驳回的不动。让编辑把 rejected 悄悄变回待确认，
 *   等于绕过了驳回这个结论；要重提就走重新打开，那是一个显式动作。
 */
export async function refreshCompleteness(db: Database, requirementId: string) {
  const [req] = await db.select().from(requirements).where(eq(requirements.id, requirementId));
  if (!req) return null;

  const pending = await db
    .select()
    .from(requirementClarifications)
    .where(eq(requirementClarifications.requirementId, requirementId));

  const unanswered = pending.filter((c) => c.level === 'must_confirm' && !c.answer).length;

  const completeness = scoreCompleteness({
    businessGoal: req.businessGoal,
    scope: req.scope,
    acceptanceCriteria: req.acceptanceCriteria,
    risks: req.risks,
    businessContext: req.businessContext,
    unansweredMustConfirm: unanswered,
  });

  /**
   * ★ 还是一张白纸时保持 draft。
   *   只改了业务背景就把状态推到「待确认」，会让需求列表上出现一条
   *   等着人拍板、而实际上什么都没写的需求。
   */
  const settled = req.status === 'approved' || req.status === 'rejected';
  const status = settled
    ? req.status
    : unanswered > 0
      ? 'clarifying'
      : hasStructuredContent(req)
        ? 'awaiting_approval'
        : req.status;

  const [updated] = await db
    .update(requirements)
    .set({ completeness: completeness as unknown as Record<string, unknown>, status })
    .where(eq(requirements.id, requirementId))
    .returning();

  return updated ?? null;
}

export type ApproveResult =
  | { ok: true; requirementId: string }
  | { ok: false; code: 'UNANSWERED_MUST_CONFIRM'; questions: { id: string; question: string }[] }
  | { ok: false; code: 'EMPTY_REQUIREMENT'; questions?: undefined };

/**
 * Human Gate：需求确认（产品文档 8.2.5）。
 *
 * 必答问题未回答时阻断 —— 这是最后一次以极低成本纠正需求理解错误的机会，
 * 放过去之后的返工成本要高一个数量级。
 *
 * ★ 闸门只有两道：**有没有内容**、**必答问题答完没有**。
 *   两道都不问「这份内容是 AI 出的还是人写的」—— 规划器读的是库里那几个
 *   结构化字段，它不关心字段是怎么来的，闸门也不该关心。
 */
/**
 * 需求状态流转的**服务端**判据。
 *
 * ★★ 在此之前完全没有这一层：approve 不看当前状态，于是一条已经 approved
 *   的需求可以被再批一次（覆盖 approvedBy 与 approvedAt），一条 rejected 的
 *   也能被直接批准。界面上按钮是灰的，而接口是敞开的 —— 而「界面挡住了」
 *   从来不是一道防线。
 *
 * ★ 只列**允许**的迁移，不列禁止的：新增一个状态时，忘了往这里加
 *   会表现为「什么都做不了」，而不是「什么都能做」。前者会被立刻发现。
 */
const REQUIREMENT_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ['analyzing', 'awaiting_approval', 'approved', 'rejected', 'on_hold'],
  analyzing: ['clarifying', 'awaiting_approval', 'draft', 'on_hold'],
  clarifying: ['analyzing', 'awaiting_approval', 'approved', 'rejected', 'on_hold'],
  awaiting_approval: ['approved', 'rejected', 'clarifying', 'analyzing', 'on_hold'],
  /**
   * ★ approved 只能回到 draft（重新打开）。不能直接再 approve ——
   *   那会静默覆盖第一次批准的人与时间，而那两个字段是问责链条的一环。
   */
  approved: ['draft'],
  rejected: ['draft'],
  on_hold: ['draft', 'analyzing', 'clarifying', 'awaiting_approval'],
};

export class RequirementStateError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`需求当前状态是 ${from}，不能变成 ${to}`);
  }
}

export function assertRequirementTransition(from: string, to: string): void {
  if (from === to) return;
  const allowed = REQUIREMENT_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) throw new RequirementStateError(from, to);
}

/**
 * 重新打开一条已确认 / 已驳回的需求。
 *
 * ★★ 缺了它，需求确认就是**单向门**：批错了、或者业务变了，
 *   唯一的出路是新建一条需求 —— 而那会让计划、任务、讨论全部与原需求脱钩。
 *
 * ★ 清掉 approvedBy / approvedAt：留着的话，页面上会显示「已由张三确认」
 *   而它此刻明明是草稿状态。已有的计划不动 —— 它们是历史，
 *   重新规划会生成新版本（plans.version），旧版留着对照。
 */
export async function reopenRequirement(
  db: Database,
  input: { requirementId: string; actorId: string; reason: string; correlationId: string },
): Promise<{ ok: true; requirementId: string }> {
  const [req] = await db
    .select()
    .from(requirements)
    .where(eq(requirements.id, input.requirementId));
  if (!req) throw new Error(`需求不存在: ${input.requirementId}`);

  assertRequirementTransition(req.status, 'draft');

  await db
    .update(requirements)
    .set({
      status: 'draft',
      approvedBy: null,
      approvedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(requirements.id, req.id));

  await emitAndPublish(db, {
    type: 'requirement.reopened',
    orgId: req.orgId,
    projectId: req.projectId,
    actor: humanActor(input.actorId),
    subjectType: 'requirement',
    subjectId: req.id,
    // ★ 原因必填：重新打开一条已确认的需求会让下游的计划全部作废，
    //   三周后没人记得为什么
    payload: { from: req.status, reason: input.reason },
    correlationId: input.correlationId,
  });

  return { ok: true, requirementId: req.id };
}

export async function approveRequirement(
  db: Database,
  input: { requirementId: string; approverId: string; correlationId: string; note?: string },
): Promise<ApproveResult> {
  const [req] = await db
    .select()
    .from(requirements)
    .where(eq(requirements.id, input.requirementId));
  if (!req) throw new Error(`需求不存在: ${input.requirementId}`);

  /**
   * ★ 一张白纸不能被确认。
   *   放过去的话，规划器拿着一份空需求照样能生成一份计划 ——
   *   那份计划里的任务全是它自己编的，而页面上它看起来和正常的计划没区别。
   */
  // ★ 状态校验在内容校验之前：一条已经批过的需求，报「内容为空」是答非所问
  assertRequirementTransition(req.status, 'approved');

  if (!hasStructuredContent(req)) {
    return { ok: false, code: 'EMPTY_REQUIREMENT' };
  }

  const clarifications = await db
    .select()
    .from(requirementClarifications)
    .where(eq(requirementClarifications.requirementId, req.id));

  const unanswered = clarifications.filter((c) => c.level === 'must_confirm' && !c.answer);
  if (unanswered.length > 0) {
    return {
      ok: false,
      code: 'UNANSWERED_MUST_CONFIRM',
      questions: unanswered.map((c) => ({ id: c.id, question: c.question })),
    };
  }

  await db
    .update(requirements)
    .set({
      status: 'approved',
      approvedBy: input.approverId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(requirements.id, req.id));

  const completeness = req.completeness as unknown as Completeness;

  await emitAndPublish(db, {
    type: 'requirement.approved',
    orgId: req.orgId,
    projectId: req.projectId,
    actor: humanActor(input.approverId),
    subjectType: 'requirement',
    subjectId: req.id,
    payload: {
      approver: input.approverId,
      completenessAtApproval: completeness?.total ?? null,
      note: input.note ?? null,
    },
    correlationId: input.correlationId,
  });

  return { ok: true, requirementId: req.id };
}
