import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  agents,
  plans,
  policies,
  projects,
  projectAgentBindings,
  projectAgentPermissions,
  projectMembers,
  repositories,
  requirementAssumptions,
  requirementClarifications,
  requirements,
  storageTargets,
  workItemDependencies,
  workItems,
  type Database,
} from '@apos/db';
import {
  humanActor,
  STATUS_STAGE,
  SYSTEM_ACTOR,
  type AssigneeHintCode,
  type AutoActionCode,
  type ConsequenceParams,
  type HumanGateCode,
  type PolicyContext,
} from '@apos/contracts';
import {
  compile,
  evaluate,
  explainAction,
  formatTokens,
  requiresHuman,
} from '@apos/domain';
import type { RuntimeRegistry } from '@apos/agent-runtimes';
import { executionModeOf, resolveExecutor } from '../agent/matching';
import { defaultBus, emitAndPublish } from '../event/bus';
import { emit, type EmittedEvent } from '../event/emitter';
import { allocateNumbers } from '../work-item/numbering';
import { transitionInTransaction } from '../flow/transition';
import type { GeneratedPlan, PlanningProvider, StructuredRequirement } from './provider';

export interface AutoAction {
  /**
   * The UI reads this code plus params, and **not** description.
   * ★ description stays as the fallback: existing snapshots contain nothing
   *   else, and for logs a ready-made sentence is simply less work.
   *   "The UI reads codes, the logs read sentences" — CLAUDE.md.
   */
  code: AutoActionCode;
  params: ConsequenceParams;
  /** @deprecated Chinese fallback for logs and old snapshots / 中文兜底句，给存量数据与日志用 */
  description: string;
  policyId: string | null;
  policyName: string | null;
  reversible: boolean;
  externalVisible: boolean;
  /**
   * Whether this entry is **an action that will happen** or **an estimate**.
   *
   * ★★ The two used to share one list, while the "irreversible" flag only makes
   *   sense for the first kind. The plan page therefore showed "estimated usage
   *   … (irreversible)" — an estimate tagged irreversible, which reads as "this
   *   money is gone the moment you approve and you cannot get it back". A usage
   *   forecast is neither an action nor something that can be "reversed"; it is
   *   just an upper bound (issue log #13).
   *
   *   估算不是动作，「不可逆」这个标记只对动作成立 —— 把用量估算标成不可逆，
   *   读起来像是「这笔钱一批就没了」。
   */
  kind: 'action' | 'estimate';
}

export interface HumanGateEntry {
  taskTitle: string;
  /**
   * **Why** this gate is here.
   *
   * ★★ `execution` = a human has to do the work; `approval` = a human has to
   *   sign off once it is done. The two used to share one list, yet what the
   *   user has to decide on seeing them is entirely different: the first is
   *   staffing, the second is oversight. Undifferentiated, "still needs human
   *   confirmation (5)" on the plan page can contain no approvals at all — all
   *   five being "these are things a person has to do".
   *
   *   `execution` 是排人，`approval` 是把关，两者混在一起会让计划页上
   *   「仍需人确认的（5）」里一条审批都没有。
   */
  cause: 'execution' | 'approval';
  /** The UI reads the code + params; reason is the fallback / 界面读码 + params，reason 是兜底句 */
  code: HumanGateCode;
  params: ConsequenceParams;
  assigneeHintCode: AssigneeHintCode;
  /** @deprecated Chinese fallback / 中文兜底 */
  reason: string;
  /** @deprecated Chinese fallback / 中文兜底 */
  assigneeHint: string;
}

export interface PlanSummary {
  planId: string;
  version: number;
  taskCount: number;
  agentTaskCount: number;
  humanTaskCount: number;
  estimatedHours: number;
  /** null = not one task gave an estimate (as opposed to estimating zero). */
  estimatedTokens: number | null;
  /** What will happen automatically once approved — the heart of the plan confirmation page. */
  autoActions: AutoAction[];
  humanGates: HumanGateEntry[];
  riskCount: number;
}

function completeTokenEstimate(
  tasks: readonly Pick<GeneratedPlan['tasks'][number], 'estimatedTokens' | 'requiresHuman'>[],
): number | null {
  if (tasks.length === 0) return null;
  let total = 0;
  for (const task of tasks) {
    if (task.estimatedTokens === null) {
      if (task.requiresHuman) continue;
      return null;
    }
    total += task.estimatedTokens;
  }
  return total;
}

/**
 * Generate an execution plan.
 *
 * The key point: auto_actions is produced by a policy dry run and stored as a
 * snapshot. What the user approves is *that list, as it stood then* — when a
 * policy changes later, it must still be possible to trace what they actually
 * approved.
 *
 * auto_actions 由 Policy 预演生成并快照存储：用户批准的是当时那份清单，
 * Policy 后来变了也要能追溯他到底批准了什么。
 */
export async function generatePlan(
  db: Database,
  provider: PlanningProvider,
  input: {
    requirementId: string;
    correlationId: string;
    /** Output language, from the caller's X-Locale. Absent, the provider writes English. */
    locale?: 'en' | 'zh';
    /**
     * What the user wrote when they asked for revisions.
     *
     * ★ It is passed to the planner only, and never written into the new
     *   version's revisionFeedback. That column means "why **this version** was
     *   sent back", written at supersede time. Have the new version also store
     *   "the feedback I was generated from" and one column carries two meanings:
     *   when v4 supersedes v3, "the reason v3 was replaced" overwrites "how v3
     *   came about", and the page shows v3 captioned with feedback it was not
     *   generated from at all. "What this version was generated from" is simply
     *   the previous version's revisionFeedback — no second copy needed.
     *
     *   只传给规划器，不写进新版本的 revisionFeedback：两种含义共用一列，
     *   会让 v3 顶着一句它根本不是基于其生成的意见。
     */
    feedback?: string;
  },
): Promise<PlanSummary> {
  const started = Date.now();

  const [req] = await db
    .select()
    .from(requirements)
    .where(eq(requirements.id, input.requirementId));
  if (!req) throw new Error(`需求不存在: ${input.requirementId}`);
  if (req.status !== 'approved') {
    throw new Error(`需求尚未确认，当前状态: ${req.status}`);
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, req.projectId));

  /**
   * ★★ Assumptions and clarifications have to travel to the planner together.
   *
   *   Both fields used to be hard-coded empty arrays, so `assumptions:
   *   req.assumptions` in buildPlanBrief always came up empty — the planning
   *   agent could not see what the previous AI step assumed or which
   *   clarifying questions a human answered, and had to re-guess it all from
   *   the structured fields. Everything the user answered, item by item, on the
   *   requirement page was lost by the time planning ran.
   *
   * ★ Carry only **answered** clarifications and assumptions **not yet
   *   invalidated**: unanswered questions are noise, and an assumption already
   *   proven wrong steers planning in a known-wrong direction.
   *
   *   只带已回答的澄清与未被证伪的假设 —— 否则用户在需求页上逐条回答的
   *   东西，到计划这一步全丢了。
   */
  const [clarificationRows, assumptionRows] = await Promise.all([
    db
      .select()
      .from(requirementClarifications)
      .where(eq(requirementClarifications.requirementId, req.id)),
    db
      .select()
      .from(requirementAssumptions)
      .where(
        and(
          eq(requirementAssumptions.requirementId, req.id),
          isNull(requirementAssumptions.invalidatedAt),
        ),
      ),
  ]);

  const structured: StructuredRequirement = {
    title: req.title ?? '',
    businessContext: req.businessContext ?? '',
    userProblem: req.userProblem ?? '',
    businessGoal: req.businessGoal ?? '',
    userStories: req.userStories as string[],
    scope: req.scope as { inScope: string[]; outOfScope: string[] },
    nonFunctional: req.nonFunctional as string[],
    successMetrics: req.successMetrics as string[],
    constraints: req.constraints as string[],
    risks: req.risks as string[],
    acceptanceCriteria: req.acceptanceCriteria,
    clarifications: clarificationRows
      .filter((c) => c.answer !== null)
      .map((c) => ({
        question: c.question,
        level: c.level,
        impact: c.impact ?? '',
        agentSuggestion: c.agentSuggestion,
        suggestionBasis: c.suggestionBasis,
        options: (c.options as string[]) ?? [],
        /** ★ The answer is the part planning needs — carrying only the question carries nothing. */
        answer: c.answer,
      })),
    assumptions: assumptionRows.map((a) => a.statement),
    provenance: {},
    cost: 0,
    model: '',
  };

  // ★ Feedback must reach the planner, not merely the database — stored but unused makes "request changes" a fake button
  const generated = await provider.generatePlan(
    structured,
    project?.type ?? 'development',
    input.feedback,
    // ★ Carry requirementId: it is how a planning run is reachable again from the requirement page
    {
      orgId: req.orgId,
      projectId: req.projectId,
      requirementId: req.id,
      ...(req.authorAgentId ? { agentId: req.authorAgentId } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
    },
  );

  const [prev] = await db
    .select({ version: plans.version })
    .from(plans)
    .where(eq(plans.requirementId, req.id))
    .orderBy(desc(plans.version))
    .limit(1);

  const version = (prev?.version ?? 0) + 1;

  const rules = await loadRules(db, req.orgId, req.projectId);
  const { autoActions, humanGates } = predictPolicyOutcomes(generated, {
    projectType: project?.type ?? 'development',
    autonomyLevel: project?.autonomyLevel ?? 'agent_led_approval',
    budget: project?.tokenBudget ? project.tokenBudget : null,
    spent: Number(project?.tokensSpent ?? 0),
    rules,
  });

  const estimatedHours = generated.tasks.reduce((s, t) => s + t.estimatedHours, 0);
  /**
   * ★★ A plan estimate is complete or unknown; a partial sum must never masquerade
   * as the whole plan.
   *
   *   Summing only the known tasks underestimates the plan. That is the dangerous
   *   direction for a budget gate: 70k known + one unknown would pass a 100k
   *   budget even when the real total is 140k. Preserve null when any automatic
   *   task is unknown, and let preflight require a complete estimate when the
   *   project has a budget. Human-only tasks consume no Agent tokens, so their
   *   null remains an intentional zero contribution.
   *
   *   计划估算要么完整，要么未知。只加已知项会低估总量，让本该拦下的计划
   *   穿过预算闸门；所以只要有一项自动任务未知，整份计划就保留为 null。
   */
  const estimatedTokens = completeTokenEstimate(generated.tasks);

  /**
   * ★★ The plan, its tasks, and the dependency edges must land in **one
   *   transaction**.
   *
   *   They used to be three independent writes: insert plans, then loop
   *   inserting workItems, then insert the dependency edges. A process dying
   *   partway (or one task violating a constraint) left a plan marked
   *   "generated" with only its first few tasks underneath — and the plan page
   *   looked entirely normal, so the user only discovered half the work was
   *   missing after approving it. Half a plan is far more dangerous than no
   *   plan.
   *
   * ★ Number allocation goes inside too: it advances the project's sequence
   *   counter, and a rollback should hand those numbers back, or task numbers
   *   develop inexplicable gaps.
   *
   *   三者必须同一个事务：半份计划比没有计划危险得多。编号分配也放进来，
   *   否则回滚会让任务编号莫名其妙地跳段。
   */
  const plan = await db.transaction(async (tx) => {
  const [plan] = await tx
    .insert(plans)
    .values({
      projectId: req.projectId,
      requirementId: req.id,
      version,
      status: 'awaiting_approval',
      phases: [...new Set(generated.tasks.map((t) => t.phase))],
      milestones: generated.milestones,
      risks: generated.risks,
      estimatedHours: String(estimatedHours),
      estimatedTokens,
      autoActions: autoActions as unknown[],
      humanGates: humanGates as unknown[],
      model: generated.model,
      generationCost: generated.cost === null ? null : String(generated.cost),
      generationMs: Date.now() - started,
      generationFallback: generated.fallback ?? null,
    })
    .returning();

  // Tasks are created as draft first and only move to ready once approved
  /**
   * ★ Claim the whole batch of numbers at once rather than one per task.
   *   Allocating inside the loop lets somebody else's numbers slot in between,
   *   so tasks from one plan get non-contiguous numbers — which reads as though
   *   a few of them went missing.
   *
   *   一次把这批号全要过来：循环分配会让同一份计划的任务编号不连续，
   *   读起来像是丢了几条。
   */
  const numbers = await allocateNumbers(tx, req.projectId, generated.tasks.length);
  const refToId = new Map<string, string>();
  for (const [index, task] of generated.tasks.entries()) {
    const [row] = await tx
      .insert(workItems)
      .values({
        orgId: req.orgId,
        projectId: req.projectId,
        number: numbers[index]!,
        requirementId: req.id,
        planId: plan!.id,
        type: task.type,
        status: 'draft',
        stage: STATUS_STAGE['draft'],
        title: task.title,
        description: task.description,
        riskLevel: task.riskLevel,
        estimatedHours: String(task.estimatedHours),
        estimatedTokens: task.estimatedTokens,
        acceptanceCriteria: task.acceptanceCriteria,
        typeData: {
          phase: task.phase,
          requiredSkills: task.requiredSkills,
          requiredCapabilities: task.requiredCapabilities,
          requiredTools: task.requiredTools,
          /**
           * ★★ executionMode and approvalGate are two different things.
           *
           *   "Only a human can do this work" and "does it need sign-off when
           *   done" are orthogonal in product terms: copy a human has to write
           *   does not necessarily need approval, while an automated production
           *   release almost certainly does. Collapsed into a single
           *   requiresHuman, "agent executes + human approves" becomes
           *   inexpressible, and that column on the plan page reads "🤖 Agent"
           *   with no sign that a gate follows.
           *
           * ★ requiresHuman is kept alongside: old work items have only that
           *   field, and the reader (executionModeOf) honors both. It can go
           *   once every historical row carries executionMode.
           *
           *   两者正交，合成一个 requiresHuman 之后「Agent 执行 + 人类审批」
           *   就表达不了了；requiresHuman 留着是因为老工作项只有它。
           */
          executionMode: task.requiresHuman ? 'human' : 'auto',
          requiresHuman: task.requiresHuman,
          ...(task.operationType ? { operationType: task.operationType } : {}),
          ...(task.environment ? { environment: task.environment } : {}),
          /**
           * ★ Nobody used to write these two into typeData, so
           *   buildPolicyContext always read null / false — rules like
           *   "accessing restricted data needs approval" and "external-facing
           *   content needs human confirmation" could therefore never match,
           *   while the user believed they had configured them.
           *
           *   这两项此前没人写进 typeData，于是相关规则永远不会命中，
           *   而用户以为自己配好了。
           */
          ...(task.dataSensitivity ? { dataSensitivity: task.dataSensitivity } : {}),
          ...(task.externalFacing !== undefined ? { externalFacing: task.externalFacing } : {}),
        },
      })
      .returning({ id: workItems.id });
    refToId.set(task.ref, row!.id);
  }

  for (const task of generated.tasks) {
    for (const dep of task.dependsOn) {
      const fromId = refToId.get(dep.ref);
      const toId = refToId.get(task.ref);
      if (!fromId || !toId) continue;
      await tx.insert(workItemDependencies).values({
        projectId: req.projectId,
        fromId,
        toId,
        type: dep.type,
        createdByType: 'system',
      });
    }
  }

    return plan!;
  });

  /**
   * ★ The event is published **after** the transaction commits (the discipline
   *   in modules/event/bus.ts). Publishing inside pushes "plan generated" to the
   *   browser and then rolls the transaction back — the user clicks through to a
   *   plan that does not exist.
   *
   *   事务内发布会把「计划已生成」推给浏览器而事务随后回滚。
   */
  await emitAndPublish(db, {
    type: 'plan.generated',
    orgId: req.orgId,
    projectId: req.projectId,
    actor: SYSTEM_ACTOR,
    subjectType: 'plan',
    subjectId: plan.id,
    payload: {
      version,
      taskCount: generated.tasks.length,
      estimatedTokens,
      estimatedHours,
      durationMs: Date.now() - started,
      model: generated.model,
    },
    correlationId: input.correlationId,
  });

  const humanTaskCount = generated.tasks.filter((t) => t.requiresHuman).length;

  return {
    planId: plan.id,
    version,
    taskCount: generated.tasks.length,
    agentTaskCount: generated.tasks.length - humanTaskCount,
    humanTaskCount,
    estimatedHours,
    estimatedTokens,
    autoActions,
    humanGates,
    riskCount: generated.risks.length,
  };
}

async function loadRules(db: Database, orgId: string, projectId: string) {
  const rows = await db.select().from(policies).where(eq(policies.orgId, orgId));
  const scoped = rows.filter((r) => r.projectId === null || r.projectId === projectId);
  return compile(
    scoped.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      projectId: r.projectId,
      name: r.name,
      description: r.description,
      priority: r.priority,
      enabled: r.enabled,
      condition: r.condition,
      action: r.action,
    })),
  );
}

/**
 * Policy dry run — translating abstract rules into "what happens once you
 * approve".
 *
 * Page doc 04 §5.3: approving a plan means approving a batch of automated
 * behavior, so the user has to see plainly what they are giving up and where
 * the safety net is.
 */
/**
 * Policy action → the code for "what the system will do next".
 *
 * ★ One-to-one with explainAction(), but producing a code rather than a Chinese
 *   sentence. explainAction stays — it feeds logs and notifications, where a
 *   ready-made sentence is less work.
 */
function assigneeHintCodeFor(action: { type: string }): AssigneeHintCode {
  switch (action.type) {
    case 'allow':
      return 'auto_allow';
    case 'allow_and_notify':
      return 'auto_notify';
    case 'require_agent_review':
      return 'agent_review';
    case 'require_human_review':
      return 'human_review';
    case 'require_multiple_approvals':
      return 'multiple_approvals';
    case 'ask':
      return 'ask';
    case 'pause':
      return 'pause';
    case 'deny':
      return 'deny';
    case 'escalate':
      return 'escalate';
    case 'transfer_to_human':
      return 'transfer_to_human';
    /**
     * ★ An unrecognized action type falls back to "somebody has to handle this"
     *   rather than "let it through automatically". The cost of guessing wrong
     *   is asymmetric: showing "needs a human" as "automatic" makes the user
     *   think there is nothing to do, while the reverse costs them one extra
     *   glance.
     *
     *   猜错方向的代价不对称，所以认不出来时回落到「得有人处理」。
     */
    default:
      return 'project_member';
  }
}

function predictPolicyOutcomes(
  plan: GeneratedPlan,
  ctx: {
    projectType: string;
    autonomyLevel: PolicyContext['autonomyLevel'];
    budget: number | null;
    spent: number;
    rules: ReturnType<typeof compile>;
  },
): { autoActions: AutoAction[]; humanGates: HumanGateEntry[] } {
  const autoActions: AutoAction[] = [];
  const humanGates: HumanGateEntry[] = [];
  const autoTaskTitles: string[] = [];

  for (const task of plan.tasks) {
    const policyCtx: PolicyContext = {
      projectType: ctx.projectType,
      workItemType: task.type,
      riskLevel: task.riskLevel,
      reversible: task.operationType !== 'db_ddl' && task.operationType !== 'delete_resource',
      /**
       * ★ The dry-run context has to match the one used at real execution time.
       *   These two were hard-coded to false / null in the dry run, so the plan
       *   page's forecast of "what happens once you approve" could come out the
       *   opposite of the verdict at execution — and that agreement is the
       *   entire value of a dry run.
       *
       *   预演的全部价值就在于它与真正执行时的判定一致。
       */
      externalFacing: task.externalFacing ?? false,
      environment: task.environment ?? null,
      dataSensitivity: task.dataSensitivity ?? null,
      impactTaskCount: plan.tasks.filter((t) => t.dependsOn.some((d) => d.ref === task.ref)).length,
      impactServices: [],
      operationType: task.operationType ?? 'code_change',
      agentType: task.requiresHuman ? null : 'code',
      agentConfidence: null,
      agentSuccessRate: null,
      consecutiveFailures: 0,
      runTokens: task.estimatedTokens ?? 0,
      projectTokensSpent: ctx.spent,
      projectTokenBudget: ctx.budget,
      budgetUsedPct: ctx.budget ? (ctx.spent / ctx.budget) * 100 : null,
      testsResult: 'not_run',
      testCoverage: null,
      securityScan: 'not_run',
      agentReview: 'not_run',
      autonomyLevel: ctx.autonomyLevel,
    };

    const verdict = evaluate(policyCtx, ctx.rules);

    /**
     * ★★ 「人来执行」不等于「要人批准」。
     *
     *   这一条以前和 Policy 判出来的审批闸混在同一个列表里，于是计划页上
     *   「仍需人确认的」既包含「这活得人干」也包含「这活干完要人批」——
     *   而用户看到它时要做的判断完全不同：前者是排人，后者是把关。
     *   cause 把两者分开，文案也分开。
     */
    if (task.requiresHuman) {
      humanGates.push({
        taskTitle: task.title,
        cause: 'execution',
        code: 'execution_required',
        params: {},
        assigneeHintCode: 'project_member',
        reason: '该任务需要人来执行（不是审批闸）',
        assigneeHint: '项目成员',
      });
      continue;
    }

    if (requiresHuman(verdict.action)) {
      humanGates.push({
        taskTitle: task.title,
        cause: 'approval',
        /**
         * ★ Policy 名是**用户起的名字**，作为参数原样带过去，不翻译 ——
         *   翻译一个用户自定义的名称等于给它改名（CLAUDE.md）。
         */
        ...(verdict.matchedPolicyName
          ? {
              code: 'policy_requires_human' as const,
              params: { policy: verdict.matchedPolicyName },
              reason: `Policy「${verdict.matchedPolicyName}」要求人工介入`,
            }
          : {
              code: 'autonomy_requires_confirm' as const,
              params: { risk: task.riskLevel },
              reason: `项目自治等级下 ${task.riskLevel} 风险任务需人工确认`,
            }),
        assigneeHintCode: assigneeHintCodeFor(verdict.action),
        assigneeHint: explainAction(verdict.action),
      });
    } else {
      autoTaskTitles.push(task.title);
    }
  }

  if (autoTaskTitles.length > 0) {
    autoActions.push({
      code: 'agents_execute',
      params: { count: autoTaskTitles.length, titles: autoTaskTitles.join('、') },
      description: `${autoTaskTitles.length} 个任务将由 Agent 自动执行：${autoTaskTitles.join('、')}`,
      policyId: null,
      policyName: null,
      reversible: true,
      externalVisible: false,
      kind: 'action',
    });
  }

  const totalTokens = completeTokenEstimate(plan.tasks);
  if (totalTokens !== null && totalTokens > 0) {
    const pct = ctx.budget ? ((totalTokens / ctx.budget) * 100).toFixed(1) : null;
    /**
     * ★★ 这里曾经是 `$${totalTokens.toFixed(2)}` —— 把一个 **token 数**
     *   印成了金额。33 万 token 于是显示为「$330000.00」，而它旁边还挂着
     *   「不可逆」：用户看到的是「批一下就要花三十三万美元，而且退不了」
     *   （问题记录 #13）。
     *
     *   记账单位本来就是 token，不是金额（见 CLAUDE.md 与 format/tokens）——
     *   单价会随官方调价漂移，token 数不会。
     *
     * ★ 而且它是**估算**不是动作：`kind: 'estimate'`，不再标不可逆。
     */
    autoActions.push({
      code: 'token_estimate',
      params: { tokens: formatTokens(totalTokens), ...(pct ? { percent: pct } : {}) },
      description: `预计消耗 ${formatTokens(totalTokens)} token${pct ? `（约占预算 ${pct}%）` : ''}，实际用量以运行结果为准`,
      policyId: null,
      policyName: null,
      reversible: true,
      externalVisible: false,
      kind: 'estimate',
    });
  }

  /**
   * ★ 判据是**能力**，不是工具名。`create_pr` 是 mock 运行时的词，
   *   真实运行时永远不会出现它 —— 按工具名判的结果是：真跑 opencode /
   *   claude-code 的计划，这条「会自动开 PR」的警告一次都不会显示。
   *   存量计划里只有工具名，所以两者都认。
   */
  const opensPullRequest = plan.tasks.some(
    (t) =>
      t.requiredCapabilities.includes('pull_request.create') ||
      t.requiredTools.includes('create_pr'),
  );
  if (opensPullRequest) {
    autoActions.push({
      code: 'pull_request_create',
      params: {},
      description: '将自动创建 Pull Request',
      policyId: null,
      policyName: null,
      reversible: true,
      externalVisible: true,
      kind: 'action',
    });
  }

  return { autoActions, humanGates };
}

export type ApprovePlanResult =
  | { ok: true; planId: string; activatedTasks: number; unclaimed: number }
  | { ok: false; code: 'BUDGET_EXCEEDED'; estimated: number; budget: number }
  | { ok: false; code: 'PREFLIGHT_FAILED'; issues: PlanPreflightIssue[] }
  | { ok: false; code: 'PLAN_NOT_APPROVABLE'; status: string }
  | { ok: false; code: 'ACTIVATION_FAILED'; taskId: string; detail: unknown }
  /**
   * ★★ 有人工任务没人认领。
   *
   *   这不是「不许批准」，是「批准之前得知道」。一个 executionMode=human
   *   却没有执行者的任务，批下去之后会进 ready 然后**停在那里**：
   *   调度器不碰人工任务，而没有人被通知过它是自己的。它不报错、不失败，
   *   只是永远不动 —— 计划看起来批了，其中几项其实没人接。
   *
   *   与 BUDGET_EXCEEDED 同一套形态：先拦一次、说清楚是哪几项，
   *   调用方确认后再放行（那时它们进「待认领」）。
   */
  | {
      ok: false;
      code: 'UNASSIGNED_HUMAN_TASKS';
      tasks: { id: string; title: string }[];
    };

export type PlanPreflightCode =
  | 'fallback_plan'
  | 'empty_plan'
  | 'planner_unavailable'
  | 'agent_unavailable'
  | 'agent_scope_missing'
  | 'workspace_source_missing'
  | 'verification_missing'
  | 'token_estimate_missing'
  | 'delivery_goal_missing';

export interface PlanPreflightIssue {
  code: PlanPreflightCode;
  taskIds: string[];
  taskTitles: string[];
  fixPath: string;
}

/**
 * One server-side verdict powers both the checklist and the approval gate.
 * A warning computed only in the browser can be bypassed by calling the API,
 * while a check computed only after scheduling discovers the problem too late.
 */
export async function evaluatePlanPreflight(
  db: Database,
  plan: typeof plans.$inferSelect,
  tasks: (typeof workItems.$inferSelect)[],
  options: { registry?: RuntimeRegistry } = {},
): Promise<PlanPreflightIssue[]> {
  const issues: PlanPreflightIssue[] = [];
  const requirementPath = plan.requirementId
    ? `/projects/${plan.projectId}/requirements/${plan.requirementId}`
    : `/projects/${plan.projectId}/requirements`;

  if (plan.generationFallback !== null) {
    issues.push({
      code: 'fallback_plan',
      taskIds: [],
      taskTitles: [],
      fixPath: requirementPath,
    });
  }
  if (tasks.length === 0) {
    issues.push({
      code: 'empty_plan',
      taskIds: [],
      taskTitles: [],
      fixPath: requirementPath,
    });
    return issues;
  }

  const agentMembers = await db
    .select({ actorId: projectMembers.actorId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, plan.projectId),
        eq(projectMembers.actorType, 'agent'),
      ),
    );
  const memberIds = agentMembers.map((member) => member.actorId);
  const activeMembers = memberIds.length > 0
    ? await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(inArray(agents.id, memberIds), eq(agents.status, 'active')))
    : [];
  const activeMemberIds = new Set(
    activeMembers
      .filter((agent) => !options.registry || options.registry.has(agent.id))
      .map((agent) => agent.id),
  );
  const [requirement] = plan.requirementId
    ? await db
        .select({ authorAgentId: requirements.authorAgentId })
        .from(requirements)
        .where(eq(requirements.id, plan.requirementId))
    : [undefined];
  const plannerBindings = await db
    .select({ agentId: projectAgentBindings.agentId })
    .from(projectAgentBindings)
    .where(
      and(
        eq(projectAgentBindings.projectId, plan.projectId),
        eq(projectAgentBindings.role, 'planner'),
      ),
    );
  const plannerAvailable = requirement?.authorAgentId
    ? activeMemberIds.has(requirement.authorAgentId)
    : plannerBindings.length > 0
      ? plannerBindings.some((binding) => activeMemberIds.has(binding.agentId))
      : activeMemberIds.size > 0;
  if (!plannerAvailable) {
    issues.push({
      code: 'planner_unavailable',
      taskIds: [],
      taskTitles: [],
      fixPath: `/projects/${plan.projectId}/settings/agents`,
    });
  }

  const automatic = tasks.filter((task) => executionModeOf(task.typeData) !== 'human');
  const unrunnable: (typeof workItems.$inferSelect)[] = [];
  const candidatesByTask = new Map<string, string[]>();
  for (const task of automatic) {
    const match = await resolveExecutor(db, task, { registry: options.registry });
    candidatesByTask.set(task.id, match.candidates.map((candidate) => candidate.agentId));
    if (match.candidates.length === 0) unrunnable.push(task);
  }
  if (unrunnable.length > 0) {
    issues.push({
      code: 'agent_unavailable',
      taskIds: unrunnable.map((task) => task.id),
      taskTitles: unrunnable.map((task) => task.title),
      fixPath: `/projects/${plan.projectId}/settings/agents`,
    });
  }

  const [preflightProject] = await db
    .select({ orgId: projects.orgId, tokenBudget: projects.tokenBudget })
    .from(projects)
    .where(eq(projects.id, plan.projectId));
  if (!preflightProject) throw new Error(`项目不存在: ${plan.projectId}`);

  const tasksWithoutEstimate = automatic.filter((task) => task.estimatedTokens === null);
  if (preflightProject.tokenBudget !== null && tasksWithoutEstimate.length > 0) {
    issues.push({
      code: 'token_estimate_missing',
      taskIds: tasksWithoutEstimate.map((task) => task.id),
      taskTitles: tasksWithoutEstimate.map((task) => task.title),
      fixPath: requirementPath,
    });
  }

  const [projectRepos, projectStorage] = await Promise.all([
    db
      .select({
        id: repositories.id,
        ref: repositories.ref,
        projectId: repositories.projectId,
        checkCommand: repositories.checkCommand,
      })
      .from(repositories)
      .where(
        and(
          eq(repositories.orgId, preflightProject.orgId),
          or(eq(repositories.projectId, plan.projectId), isNull(repositories.projectId)),
          eq(repositories.status, 'active'),
        ),
      ),
    db
      .select({ id: storageTargets.id, ref: storageTargets.ref })
      .from(storageTargets)
      .where(
        and(
          eq(storageTargets.orgId, preflightProject.orgId),
          or(eq(storageTargets.projectId, plan.projectId), isNull(storageTargets.projectId)),
          eq(storageTargets.status, 'active'),
        ),
      ),
  ]);
  const workspaceTasks = automatic.filter((task) => {
    const capabilities = task.typeData['requiredCapabilities'];
    return Array.isArray(capabilities) && capabilities.some((value) => /^workspace\.(read|write)$/.test(String(value)));
  });
  const sourceRefs = new Set([
    ...projectRepos.map((repo) => repo.ref),
    ...projectStorage.map((target) => target.ref),
  ]);
  const tasksWithoutSource = workspaceTasks.filter((task) => {
    const resources = task.typeData['requiredResources'];
    const required = Array.isArray(resources) ? resources.map(String) : [];
    return required.length > 0
      ? required.some((ref) => !sourceRefs.has(ref))
      : sourceRefs.size === 0;
  });
  if (tasksWithoutSource.length > 0) {
    issues.push({
      code: 'workspace_source_missing',
      taskIds: tasksWithoutSource.map((task) => task.id),
      taskTitles: tasksWithoutSource.map((task) => task.title),
      fixPath: `/projects/${plan.projectId}/settings/storage`,
    });
  }

  if (workspaceTasks.length > 0 && (projectRepos.length > 0 || projectStorage.length > 0)) {
    const grants = await db
      .select({
        agentId: projectAgentPermissions.agentId,
        resourceScopes: projectAgentPermissions.resourceScopes,
      })
      .from(projectAgentPermissions)
      .where(eq(projectAgentPermissions.projectId, plan.projectId));
    const scopesByAgent = new Map(grants.map((grant) => [grant.agentId, grant.resourceScopes]));
    const tasksWithoutScope = workspaceTasks.filter((task) => {
      const capabilities = task.typeData['requiredCapabilities'];
      const required = Array.isArray(capabilities) ? capabilities.map(String) : [];
      const needsWrite = required.includes('workspace.write');
      const candidateIds = candidatesByTask.get(task.id) ?? [];
      return !candidateIds.some((agentId) => {
        const scopes = scopesByAgent.get(agentId) ?? [];
        if (needsWrite) {
          return scopes.some((scope) => sourceRefs.has(scope.ref) && scope.access === 'write');
        }
        return projectRepos.some((repo) => repo.projectId === plan.projectId) || scopes.some(
          (scope) => sourceRefs.has(scope.ref) && scope.access !== 'none',
        );
      });
    });
    if (tasksWithoutScope.length > 0) {
      issues.push({
        code: 'agent_scope_missing',
        taskIds: tasksWithoutScope.map((task) => task.id),
        taskTitles: tasksWithoutScope.map((task) => task.title),
        fixPath: `/projects/${plan.projectId}/settings/agents`,
      });
    }
  }

  const needsAutomaticVerification = automatic.some((task) =>
    task.acceptanceCriteria.some((criterion) => criterion.verification === 'auto'),
  );
  if (needsAutomaticVerification && !projectRepos.some((repo) => Boolean(repo.checkCommand?.trim()))) {
    issues.push({
      code: 'verification_missing',
      taskIds: automatic
        .filter((task) => task.acceptanceCriteria.some((criterion) => criterion.verification === 'auto'))
        .map((task) => task.id),
      taskTitles: automatic
        .filter((task) => task.acceptanceCriteria.some((criterion) => criterion.verification === 'auto'))
        .map((task) => task.title),
      fixPath: `/projects/${plan.projectId}/settings/storage`,
    });
  }

  if (!tasks.some((task) => task.acceptanceCriteria.some((criterion) => criterion.text.trim().length > 0))) {
    issues.push({
      code: 'delivery_goal_missing',
      taskIds: tasks.map((task) => task.id),
      taskTitles: tasks.map((task) => task.title),
      fixPath: requirementPath,
    });
  }

  return issues;
}

/**
 * Human Gate：计划批准。批准后任务从 draft 转 ready，Scheduler 开始接手。
 */
export async function approvePlan(
  db: Database,
  input: {
    planId: string;
    approverId: string;
    correlationId: string;
    acknowledgedOverrun?: boolean;
    /** 确认「这几项人工任务先进待认领队列」 */
    acknowledgedUnassigned?: boolean;
  },
  options: { registry?: RuntimeRegistry } = {},
): Promise<ApprovePlanResult> {
  try {
    const finalized = await db.transaction(async (tx) => {
      /**
       * ★★ Approval is one locked state change, not a plan update followed by N
       * independent task transactions.
       *
       *   The lock makes a retried HTTP request observe the committed status
       *   instead of overwriting approvedBy/approvedAt and emitting a second
       *   approval event. Keeping every task transition in this transaction also
       *   means an activation failure rolls the entire approval back.
       */
      const [plan] = await tx
        .select()
        .from(plans)
        .where(eq(plans.id, input.planId))
        .for('update');
      if (!plan) throw new Error(`计划不存在: ${input.planId}`);
      if (plan.status !== 'awaiting_approval') {
        return {
          result: { ok: false as const, code: 'PLAN_NOT_APPROVABLE' as const, status: plan.status },
          events: [] as EmittedEvent[],
        };
      }

      const [project] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, plan.projectId))
        .for('update');
      if (!project) throw new Error(`项目不存在: ${plan.projectId}`);

      const tasks = await tx
        .select()
        .from(workItems)
        .where(eq(workItems.planId, plan.id))
        .for('update');
      const inconsistent = tasks.find((task) => task.status !== 'draft');
      if (inconsistent) {
        return {
          result: {
            ok: false as const,
            code: 'PLAN_NOT_APPROVABLE' as const,
            status: `task:${inconsistent.id}:${inconsistent.status}`,
          },
          events: [] as EmittedEvent[],
        };
      }

      const estimated = plan.estimatedTokens;
      const budget = project.tokenBudget;
      if (
        budget !== null &&
        estimated !== null &&
        estimated > budget &&
        !input.acknowledgedOverrun
      ) {
        return {
          result: { ok: false as const, code: 'BUDGET_EXCEEDED' as const, estimated, budget },
          events: [] as EmittedEvent[],
        };
      }

      // evaluatePlanPreflight only uses query methods; the transaction handle is
      // deliberately passed through so the verdict sees the same locked snapshot.
      const preflightIssues = await evaluatePlanPreflight(
        tx as unknown as Database,
        plan,
        tasks,
        options,
      );
      if (preflightIssues.length > 0) {
        return {
          result: {
            ok: false as const,
            code: 'PREFLIGHT_FAILED' as const,
            issues: preflightIssues,
          },
          events: [] as EmittedEvent[],
        };
      }

      const unassignedHuman = tasks.filter(
        (task) => executionModeOf(task.typeData) === 'human' && !task.executorId,
      );
      if (unassignedHuman.length > 0 && !input.acknowledgedUnassigned) {
        return {
          result: {
            ok: false as const,
            code: 'UNASSIGNED_HUMAN_TASKS' as const,
            tasks: unassignedHuman.map((task) => ({ id: task.id, title: task.title })),
          },
          events: [] as EmittedEvent[],
        };
      }

      const events: EmittedEvent[] = [];
      for (const task of tasks) {
        const moved = await transitionInTransaction(tx, {
          workItemId: task.id,
          trigger: 'plan_approved',
          actor: humanActor(input.approverId),
          correlationId: input.correlationId,
        });
        if (!moved.ok) throw new PlanActivationError(task.id, moved);
        events.push(...moved.events);
      }

      await tx
        .update(plans)
        .set({
          status: 'approved',
          approvedBy: [input.approverId],
          approvedAt: new Date(),
        })
        .where(eq(plans.id, plan.id));

      events.push(
        await emit(tx, {
          type: 'plan.approved',
          orgId: project.orgId,
          projectId: plan.projectId,
          actor: humanActor(input.approverId),
          subjectType: 'plan',
          subjectId: plan.id,
          payload: {
            version: plan.version,
            approvers: [input.approverId],
            acknowledgedOverrun: input.acknowledgedOverrun ?? false,
            activatedTasks: tasks.length,
            unclaimedHumanTasks: unassignedHuman.length,
            autoActionsSnapshot: plan.autoActions,
          },
          correlationId: input.correlationId,
        }),
      );

      return {
        result: {
          ok: true as const,
          planId: plan.id,
          activatedTasks: tasks.length,
          unclaimed: unassignedHuman.length,
        },
        events,
      };
    });

    if (finalized.events.length > 0) defaultBus.publish(finalized.events);
    return finalized.result;
  } catch (err) {
    if (err instanceof PlanActivationError) {
      return {
        ok: false,
        code: 'ACTIVATION_FAILED',
        taskId: err.taskId,
        detail: err.detail,
      };
    }
    throw err;
  }
}

class PlanActivationError extends Error {
  constructor(
    readonly taskId: string,
    readonly detail: unknown,
  ) {
    super(`计划任务激活失败: ${taskId}`);
    this.name = 'PlanActivationError';
  }
}
