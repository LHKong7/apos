import { and, eq, sql } from 'drizzle-orm';
import {
  agentRuns,
  artifacts,
  decisions,
  policies,
  projects,
  workItemDependencies,
  workItems,
  type Database,
} from '@apos/db';
import {
  IRREVERSIBLE_OPERATIONS,
  stageFor,
  STATUS_LABELS,
  STATUS_STAGE,
  type ActorRef,
  type PolicyContext,
  type PolicyVerdict,
  type Stage,
  type WorkItemStatus,
} from '@apos/contracts';
import {
  compile,
  evaluate,
  evaluateGuards,
  PREVIOUS_STATE,
  resolveTransition,
  availableTriggers,
  WORK_ITEM_MACHINE,
  BASELINE_POLICIES,
  type GuardFailure,
  type WorkItemTrigger,
} from '@apos/domain';
import { emit, type EmittedEvent, type Tx } from '../event/emitter';
import { defaultBus } from '../event/bus';
import { buildGuardContext, buildPolicyContext } from './context';
import { applyEffects } from './effects';

export interface TransitionInput {
  workItemId: string;
  trigger: WorkItemTrigger;
  actor: ActorRef;
  /** 人类操作时必填 */
  reason?: string;
  /**
   * 原因分类。自由文本没法聚合，Analytics 的「人工覆盖原因分布」只认这个字段。
   * 不落进事件 payload 的话，看板上强制填的那一栏就白填了。
   */
  reasonCategory?: string;
  /**
   * 这次流转是人手动改的状态，而不是系统按流程推的。
   *
   * ★ 光看 actor 是人不够：批准决策、回答澄清也都是人触发的，
   *   但那些是「人在回路」按设计工作，不是覆盖系统判断。
   *   「人工覆盖率」衡量的是系统自动判断有多准，应该随时间下降 ——
   *   把正常的人类参与算进去，这个指标就再也降不下来，也就失去了意义。
   */
  manual?: boolean;
  /** 强制放行的 guard 名，需相应权限 */
  overrideGuards?: string[];
  correlationId: string;
  causationId?: bigint | null;
  /** 覆盖 Policy 上下文中由调用方才知道的字段（如本次操作类型） */
  contextOverrides?: Partial<PolicyContext>;
}

export type TransitionResult =
  | {
      ok: true;
      from: WorkItemStatus;
      to: WorkItemStatus;
      stage: Stage;
      verdict: PolicyVerdict;
      createdDecisionId: string | null;
      events: EmittedEvent[];
    }
  | {
      ok: false;
      code: 'INVALID_TRANSITION';
      from: WorkItemStatus;
      allowedTriggers: WorkItemTrigger[];
    }
  | {
      ok: false;
      code: 'GUARD_FAILED';
      from: WorkItemStatus;
      failures: GuardFailure[];
    }
  | {
      ok: false;
      code: 'POLICY_DENIED';
      from: WorkItemStatus;
      message: string;
      verdict: PolicyVerdict;
    }
  | { ok: false; code: 'NOT_FOUND' };

/**
 * ★ 唯一允许修改 Work Item 状态的入口。
 *
 * 不允许任何代码路径直接 UPDATE work_items.status —— 那会绕开事件写入，
 * 破坏产品文档 3.2 要求的可追溯性。
 *
 * 执行顺序见 docs/tech/04-flow-engine.md §3.1。
 */
export async function transition(
  db: Database,
  input: TransitionInput,
): Promise<TransitionResult> {
  const outbox: EmittedEvent[] = [];

  const result = await db.transaction(async (tx) => {
    // 1. 行锁：防止 Agent 回调与人类操作并发流转同一任务
    const [item] = await tx
      .select()
      .from(workItems)
      .where(eq(workItems.id, input.workItemId))
      .for('update');

    if (!item) return { ok: false, code: 'NOT_FOUND' } as const;

    const from = item.status;

    // 2. 状态机校验
    const rule = resolveTransition(WORK_ITEM_MACHINE, from, input.trigger);
    if (!rule) {
      return {
        ok: false,
        code: 'INVALID_TRANSITION',
        from,
        allowedTriggers: availableTriggers(WORK_ITEM_MACHINE, from),
      } as const;
    }

    // $previous：决策批准后回到进入等待前的状态
    let target: WorkItemStatus;
    if (rule.to === PREVIOUS_STATE) {
      target = item.previousStatus ?? 'ready';
    } else {
      target = rule.to;
    }

    // 3. Guard 求值
    const guardCtx = await buildGuardContext(tx, item, STATUS_STAGE[target]);
    const failures = evaluateGuards(rule.guards, guardCtx, input.overrideGuards ?? []);
    if (failures.length > 0) {
      return { ok: false, code: 'GUARD_FAILED', from, failures } as const;
    }

    // 4. Policy 评估（在事务内，判定结果决定这次流转的走向）
    const policyCtx = await buildPolicyContext(tx, item, input.contextOverrides);
    const rules = await loadCompiledPolicies(tx, item.orgId, item.projectId);
    const verdict = evaluate(policyCtx, rules);

    if (verdict.action.type === 'deny') {
      return { ok: false, code: 'POLICY_DENIED', from, message: verdict.action.message, verdict } as const;
    }

    // 5. 按判定决定最终状态
    let finalStatus = target;
    let createdDecisionId: string | null = null;

    // 记住任务「本来要去哪」：决策批准后从这里恢复，
    // 同时决定它在看板上停留在哪一列
    let intendedStatus: WorkItemStatus | null = item.previousStatus;

    /**
     * 状态机自身把任务挂起等人（decision_required / review_conflict）——
     * 它现在在哪，批准后就该回到哪。
     *
     * 少了这一步，Agent 求助、评审冲突这类挂起会因为
     * STATUS_STAGE['awaiting_decision'] === 'review' 被扔进 Review 列，
     * 看起来像「已经做完了在审核」（页面文档 05 §5.4）。
     */
    if (target === 'awaiting_decision') intendedStatus = from;

    if (verdict.requiresHuman) {
      finalStatus = verdict.action.type === 'pause' ? 'blocked' : 'awaiting_decision';
      // Policy 把流转拦下来了：本来要去的地方才是批准后的目的地
      if (target !== 'awaiting_decision') intendedStatus = target;
      createdDecisionId = await createDecisionFor(tx, item, verdict, intendedStatus ?? target);
    }

    // 6. 执行 effects
    const effectPatch = applyEffects(rule.effects, {
      item,
      actor: input.actor,
      from,
      to: finalStatus,
    });

    // 7. 写状态（乐观锁）
    const updated = await tx
      .update(workItems)
      .set({
        status: finalStatus,
        stage: stageFor(finalStatus, intendedStatus),
        version: item.version + 1,
        updatedAt: new Date(),
        previousStatus: finalStatus === 'awaiting_decision' ? intendedStatus : null,
        /**
         * Human Gate 徽标。放在这里而不是某条规则的 effects 里 ——
         * 它取决于「最终停在哪个状态」，而挂起可能来自两条完全不同的路径：
         * 状态机自身的 decision_required，或 Policy 把一次普通流转拦下来。
         * 只在其中一条路径上打徽标，另一条的卡片就只是静静停住，
         * 看板上看不出它在等人。
         */
        ...(finalStatus === 'awaiting_decision'
          ? { humanGate: 'waiting_for_decision' as const }
          : {}),
        ...effectPatch,
      })
      .where(and(eq(workItems.id, item.id), eq(workItems.version, item.version)))
      .returning({ id: workItems.id });

    if (updated.length === 0) {
      // 并发写入：不重试，让调用方拿最新状态重来
      throw new VersionConflictError(item.id, item.version);
    }

    // 8. 写事件（同事务）
    const base = {
      orgId: item.orgId,
      projectId: item.projectId,
      actor: input.actor,
      correlationId: input.correlationId,
      causationId: input.causationId ?? null,
    };

    const policyEvent = await emit(tx, {
      ...base,
      type: 'policy.evaluated',
      level: 'detail',
      subjectType: 'work_item',
      subjectId: item.id,
      payload: {
        matchedPolicyId: verdict.matchedPolicyId,
        matchedPolicyName: verdict.matchedPolicyName,
        action: verdict.action,
        trace: verdict.trace,
      },
      // ★ 上下文快照：Policy 模拟回放的唯一数据来源，事后无法补
      contextSnapshot: verdict.contextSnapshot,
    });
    outbox.push(policyEvent);

    if (createdDecisionId) {
      outbox.push(
        await emit(tx, {
          ...base,
          type: 'decision.created',
          subjectType: 'decision',
          subjectId: createdDecisionId,
          payload: {
            workItemId: item.id,
            policyId: verdict.matchedPolicyId,
            intendedStatus: target,
          },
          causationId: policyEvent.id,
        }),
      );
    }

    if (input.overrideGuards?.length) {
      outbox.push(
        await emit(tx, {
          ...base,
          type: 'work_item.force_passed',
          subjectType: 'work_item',
          subjectId: item.id,
          payload: { guards: input.overrideGuards, reason: input.reason ?? '' },
        }),
      );
    }

    outbox.push(
      await emit(tx, {
        ...base,
        type: 'work_item.status_changed',
        subjectType: 'work_item',
        subjectId: item.id,
        payload: {
          from,
          to: finalStatus,
          trigger: input.trigger,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.reasonCategory ? { reasonCategory: input.reasonCategory } : {}),
          ...(input.manual ? { manual: true } : {}),
        },
        causationId: policyEvent.id,
      }),
    );

    return {
      ok: true,
      from,
      to: finalStatus,
      stage: stageFor(finalStatus, intendedStatus),
      verdict,
      createdDecisionId,
      events: outbox,
    } as const;
  });

  // ★ 事务提交后才发布 —— 订阅者不会看到未提交的状态
  if (outbox.length > 0) defaultBus.publish(outbox);

  return result as TransitionResult;
}

export class VersionConflictError extends Error {
  constructor(
    readonly workItemId: string,
    readonly expectedVersion: number,
  ) {
    super(`Work Item ${workItemId} 已被并发修改（期望版本 ${expectedVersion}）`);
    this.name = 'VersionConflictError';
  }
}

/**
 * 取出对该项目生效的原始规则（组织级 + 项目级 + 不可删的基线）。
 *
 * ★ 与 compile 分开是因为有第二个用途：派发前要把「哪些规则会拦下这次工作」
 *   渲染成人话下发给 Agent（modules/agent/dispatch.ts），而渲染需要
 *   condition 的 AST —— CompiledRule 只留了闭包，AST 已经不在了。
 *
 * Loads the raw rules in force for a project. Kept separate from compile()
 * because dispatch needs the condition AST to render the rules into prose for
 * the agent; a CompiledRule has closed over its condition and no longer
 * carries it.
 */
export async function loadPolicies(tx: Tx, orgId: string, projectId: string) {
  const rows = await tx
    .select()
    .from(policies)
    .where(
      and(
        eq(policies.orgId, orgId),
        eq(policies.enabled, true),
        sql`(${policies.projectId} IS NULL OR ${policies.projectId} = ${projectId})`,
      ),
    );

  const stored = rows.map((r) => ({
    id: r.id,
    orgId: r.orgId,
    projectId: r.projectId,
    name: r.name,
    description: r.description,
    priority: r.priority,
    enabled: r.enabled,
    condition: r.condition,
    action: r.action,
  }));

  // 组织基线规则始终生效，即使数据库中未落库（防误删）
  const storedIds = new Set(stored.map((p) => p.id));
  const baseline = BASELINE_POLICIES.filter((p) => !storedIds.has(p.id)).map((p) => ({
    ...p,
    orgId,
  }));

  return [...baseline, ...stored];
}

async function loadCompiledPolicies(tx: Tx, orgId: string, projectId: string) {
  return compile(await loadPolicies(tx, orgId, projectId));
}

async function createDecisionFor(
  tx: Tx,
  item: typeof workItems.$inferSelect,
  verdict: PolicyVerdict,
  intendedStatus: WorkItemStatus,
): Promise<string> {
  const action = verdict.action;
  const dueInHours =
    'dueInHours' in action && typeof action.dueInHours === 'number' ? action.dueInHours : 8;

  const snapshot = verdict.contextSnapshot;

  const [row] = await tx
    .insert(decisions)
    .values({
      orgId: item.orgId,
      projectId: item.projectId,
      workItemId: item.id,
      type: decisionTypeFor(verdict),
      status: 'pending',
      riskLevel: item.riskLevel,
      /**
       * ★ 以前这里硬编码 true —— 于是「执行付款」的决策卡片上也写着「可逆」。
       *   一个永远为真的字段不是默认值，是假话：它会让「不可逆」这个
       *   标记彻底失去意义，也让批量批准的门槛形同虚设。
       */
      reversible: !IRREVERSIBLE_OPERATIONS.includes(snapshot.operationType),
      /**
       * ★ 「不处理会怎样」必须是具体后果，不是「高优先级」。
       *   这里能如实说出来的就是停滞代价：任务停在哪、几个下游跟着等。
       *   编不出来就留空，页面会跳过这一段 —— 比编一句空话好。
       */
      consequence: stallConsequence(intendedStatus, snapshot.impactTaskCount),
      title: `${item.title} —— 需要你确认`,
      whyHuman: verdict.matchedPolicyName
        ? `Policy「${verdict.matchedPolicyName}」要求人工介入`
        : `项目自治等级要求该风险级别的操作需人工确认`,
      /**
       * ★ 同一件事再说一遍，但这次说给界面听。
       *   上面那两句中文留给日志、通知与存量客户端；界面读这一栏，
       *   才能在英文界面上给出一句完整的英文，而不是
       *   「If ignored: 任务无法进入…」那种半句翻译（问题记录 #34）。
       * ★ Policy 名字作为参数原样带过去 —— 用户自己起的名不该被翻译，
       *   平台自带的九条基线规则由前端按 id 认领词条。
       */
      reasonDetail: {
        /** ★ 原样带过去，让界面自己拼「—— 需要你确认」那半句（见 DecisionReason） */
        subjectTitle: item.title,
        whyHuman: verdict.matchedPolicyName
          ? {
              code: 'policy_requires_human' as const,
              params: {
                policy: verdict.matchedPolicyName,
                policyId: verdict.matchedPolicyId ?? '',
              },
            }
          : { code: 'autonomy_requires_human' as const, params: { risk: item.riskLevel } },
        consequence:
          snapshot.impactTaskCount > 0
            ? {
                code: 'stalled_with_downstream' as const,
                params: { status: intendedStatus, count: snapshot.impactTaskCount },
              }
            : { code: 'stalled_alone' as const, params: { status: intendedStatus } },
      },
      impact: { intendedStatus },
      triggeredByPolicy: isUuid(verdict.matchedPolicyId) ? verdict.matchedPolicyId : null,
      policyTrace: verdict.trace,
      requiresCosign: action.type === 'require_multiple_approvals',
      dueAt: new Date(Date.now() + dueInHours * 3600_000),
    })
    .returning({ id: decisions.id });

  if (!row) throw new Error('决策创建失败');
  return row.id;
}

/**
 * 停滞代价。
 *
 * ★ 说的是「进不去哪」而不是「停在哪」：任务此刻的状态是 awaiting_decision，
 *   照实说「停在待决策」等于把决策的定义重复一遍。用户想知道的是
 *   这次批准放行的是什么。
 * ★ 下游为 0 时也照说 —— 「只卡住它自己」同样是决定优先级的依据。
 */
function stallConsequence(intendedStatus: WorkItemStatus, downstream: number): string {
  const where = `任务无法进入「${STATUS_LABELS[intendedStatus]}」`;
  return downstream > 0 ? `${where}，${downstream} 个下游任务跟着等` : `${where}（无下游任务受影响）`;
}

/**
 * 决策类型。导出是为了能被测试锁住：产出的每一个值都必须在
 * decisionLabel()（packages/domain analytics/hitl.ts）里有中文名，
 * 否则决策中心和 Analytics 上会直接印出裸 key。
 */
export function decisionTypeFor(verdict: PolicyVerdict): string {
  const id = verdict.matchedPolicyId ?? '';
  if (id.startsWith('baseline-prod-db')) return 'high_risk_operation';
  if (id.startsWith('baseline-prod-deploy')) return 'release_approval';
  if (id.startsWith('baseline-budget')) return 'budget_overrun';
  if (id.startsWith('baseline-consecutive-failures')) return 'agent_failure';
  if (id.startsWith('baseline-')) return 'high_risk_operation';
  return 'approval';
}

/** 基线规则用的是可读 ID（baseline-xxx），不是 UUID，不能写进外键字段 */
function isUuid(v: string | null): v is string {
  return (
    v !== null &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}

export { workItems, workItemDependencies, agentRuns, artifacts, projects };
