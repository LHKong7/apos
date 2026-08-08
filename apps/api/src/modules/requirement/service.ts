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
  const completeness = scoreCompleteness({
    businessGoal: structured.businessGoal,
    scope: structured.scope,
    acceptanceCriteria: structured.acceptanceCriteria,
    risks: structured.risks,
    businessContext: structured.businessContext,
    unansweredMustConfirm: mustConfirm,
  });

  await db
    .update(requirements)
    .set({
      status: mustConfirm > 0 ? 'clarifying' : 'awaiting_approval',
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
      fieldProvenance: structured.provenance,
      completeness: completeness as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    })
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
    },
    correlationId: input.correlationId,
  });

  return {
    requirementId: req.id,
    completeness,
    clarificationCount: structured.clarifications.length,
    mustConfirmCount: mustConfirm,
    cost: structured.cost,
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

/** 回答问题后实时回升分数，给予正反馈 */
async function refreshCompleteness(db: Database, requirementId: string) {
  const [req] = await db.select().from(requirements).where(eq(requirements.id, requirementId));
  if (!req) return;

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

  await db
    .update(requirements)
    .set({
      completeness: completeness as unknown as Record<string, unknown>,
      status: unanswered === 0 ? 'awaiting_approval' : 'clarifying',
    })
    .where(eq(requirements.id, requirementId));
}

export type ApproveResult =
  | { ok: true; requirementId: string }
  | { ok: false; code: 'UNANSWERED_MUST_CONFIRM'; questions: { id: string; question: string }[] };

/**
 * Human Gate：需求确认（产品文档 8.2.5）。
 *
 * 必答问题未回答时阻断 —— 这是最后一次以极低成本纠正需求理解错误的机会，
 * 放过去之后的返工成本要高一个数量级。
 */
export async function approveRequirement(
  db: Database,
  input: { requirementId: string; approverId: string; correlationId: string; note?: string },
): Promise<ApproveResult> {
  const [req] = await db
    .select()
    .from(requirements)
    .where(eq(requirements.id, input.requirementId));
  if (!req) throw new Error(`需求不存在: ${input.requirementId}`);

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
