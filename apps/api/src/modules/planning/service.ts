import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  plans,
  policies,
  projects,
  requirementAssumptions,
  requirementClarifications,
  requirements,
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
  BASELINE_POLICIES,
  compile,
  evaluate,
  explainAction,
  formatTokens,
  requiresHuman,
} from '@apos/domain';
import { executionModeOf } from '../agent/matching';
import { emitAndPublish } from '../event/bus';
import { allocateNumbers } from '../work-item/numbering';
import { transition } from '../flow/transition';
import type { GeneratedPlan, PlanningProvider, StructuredRequirement } from './provider';

export interface AutoAction {
  /**
   * 界面读这个码 + params，**不读** description。
   * ★ description 保留为兜底：存量快照里只有它，日志里也是它更省事。
   *   「界面读码，日志读句子」——CLAUDE.md。
   */
  code: AutoActionCode;
  params: ConsequenceParams;
  /** @deprecated 中文兜底句，给存量数据与日志用 / Chinese fallback for logs and old snapshots */
  description: string;
  policyId: string | null;
  policyName: string | null;
  reversible: boolean;
  externalVisible: boolean;
  /**
   * 这一条是**会发生的动作**还是**一个估算**。
   *
   * ★★ 两者此前混在同一个列表里，而「不可逆」这个标记只对前者成立。
   *   于是计划页上出现了「预计消耗 …（不可逆）」—— 一个估算被标成
   *   不可逆，读起来像是「这笔钱一批就没了、退不回来」。用量估算本来就
   *   既不是动作也不会「逆」，它只是一个上界（问题记录 #13）。
   *
   * An estimate is not an action, and "irreversible" only makes sense for
   * actions. Tagging the usage forecast irreversible read as "this money is
   * gone the moment you approve".
   */
  kind: 'action' | 'estimate';
}

export interface HumanGateEntry {
  taskTitle: string;
  /**
   * 这道闸是**为什么**在的。
   *
   * ★★ `execution` = 这活得人干；`approval` = 干完要人批。
   *   两者以前混在同一个列表里，而用户看到它时要做的判断完全不同：
   *   前者是排人，后者是把关。分不开的话，计划页上「仍需人确认的（5）」
   *   里可能一条审批都没有 —— 全是「这几件事得人做」。
   */
  cause: 'execution' | 'approval';
  /** 界面读码 + params；reason 是兜底句 / UI reads the code, reason is the fallback */
  code: HumanGateCode;
  params: ConsequenceParams;
  assigneeHintCode: AssigneeHintCode;
  /** @deprecated 中文兜底 / Chinese fallback */
  reason: string;
  /** @deprecated 中文兜底 / Chinese fallback */
  assigneeHint: string;
}

export interface PlanSummary {
  planId: string;
  version: number;
  taskCount: number;
  agentTaskCount: number;
  humanTaskCount: number;
  estimatedHours: number;
  /** null = 一条任务都没给出估算（不是估成 0） */
  estimatedTokens: number | null;
  /** 批准后将自动发生的行为 —— 计划确认页的灵魂 */
  autoActions: AutoAction[];
  humanGates: HumanGateEntry[];
  riskCount: number;
}

/**
 * 生成执行计划。
 *
 * 关键点：auto_actions 由 Policy 预演生成并快照存储。用户批准的是
 * 「当时那份清单」，Policy 后来变了也要能追溯他到底批准了什么。
 */
export async function generatePlan(
  db: Database,
  provider: PlanningProvider,
  input: {
    requirementId: string;
    correlationId: string;
    /** 产出语言，来自调用方的 X-Locale。缺省时 provider 按英文写 */
    locale?: 'en' | 'zh';
    /**
     * 「要求修改」时用户写的意见。
     *
     * ★ 它只传给规划器，不写进新版本的 revisionFeedback。
     *   那个列的语义是「**这一版**为什么被要求改」，由 supersede 时写入 ——
     *   新版本也往里写一份「我是基于什么意见生成的」，两种含义就共用了一列，
     *   于是 v3 被 v4 取代时，「取代 v3 的理由」直接覆盖了「v3 是怎么来的」，
     *   页面上 v3 会顶着一句它根本不是基于其生成的意见。
     *   「这一版是基于什么生成的」= 上一版的 revisionFeedback，不需要再存一份。
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
   * ★★ 假设与澄清必须一起传给规划器。
   *
   *   这两栏以前是硬编码的空数组，于是 buildPlanBrief 里那句
   *   `assumptions: req.assumptions` 永远拿到空 —— 规划 Agent 看不到
   *   「上一步 AI 假设了什么」「人回答了哪些澄清问题」，只能凭结构化字段
   *   重新猜一遍。用户在需求页上逐条回答的东西，到计划这一步全丢了。
   *
   * ★ 只带**已回答**的澄清与**未被证伪**的假设：没答的问题带过去是噪声，
   *   已经被证伪的假设带过去会把规划引向已知错误的方向。
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
        /** ★ 答案本身才是规划要用的东西 —— 只带问题等于没传 */
        answer: c.answer,
      })),
    assumptions: assumptionRows.map((a) => a.statement),
    provenance: {},
    cost: 0,
    model: '',
  };

  // ★ 意见必须传给规划器，不能只存进数据库 —— 只存不用等于「要求修改」是个假按钮
  const generated = await provider.generatePlan(
    structured,
    project?.type ?? 'development',
    input.feedback,
    // ★ 带上 requirementId：规划 Run 靠它才能从需求页找回来
    {
      orgId: req.orgId,
      projectId: req.projectId,
      requirementId: req.id,
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
   * ★★ 一条都没估的时候要落 null，**不是 0**。
   *
   *   此前是 `reduce((s, t) => s + (t.estimatedTokens ?? 0), 0)`：Agent 没给
   *   估算时把一串 null 加成 0，计划页于是理直气壮地写「Token estimate 0」，
   *   批准弹窗跟着说「预计消耗 0 tokens」—— 与「这份计划真的不花 token」
   *   完全无法区分（问题记录：NEW-BUG-3）。
   *
   * ★ 部分估了就按估到的那些求和：半份估算仍然是信息，而它天然偏小，
   *   偏小的方向对预算闸门是安全的（会更早拦，不会更晚）。
   */
  const estimated = generated.tasks.map((t) => t.estimatedTokens).filter((n): n is number => typeof n === 'number');
  const estimatedTokens = estimated.length === 0 ? null : estimated.reduce((a, b) => a + b, 0);

  /**
   * ★★ 计划、任务、依赖边必须在**同一个事务**里落地。
   *
   *   在此之前它们是三段独立的写：先 insert plans，再循环 insert workItems，
   *   最后 insert 依赖边。中途进程挂掉（或某条任务违反约束）留下的是一份
   *   「已生成」的计划，底下却只有前几个任务 —— 而计划页看起来完全正常，
   *   用户批准之后才发现少了一半的活。半份计划比没有计划危险得多。
   *
   * ★ 编号分配也放进来：它自己会推进项目的序号计数器，事务回滚时
   *   那几个号就该跟着还回去，否则任务编号会莫名其妙地跳段。
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

  // 任务先建为 draft，批准后才转 ready
  /**
   * ★ 一次把这批号全要过来，不是每条各要一个。
   *   循环分配会让别人的号插进中间，同一份计划出来的任务编号不连续 ——
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
           * ★★ executionMode 与 approvalGate 是两件事。
           *
           *   「这活只能人干」和「干完要不要人批」在产品上正交：一段需要人写的
           *   文案不一定要审批，一次自动的生产发布几乎一定要。合成一个
           *   requiresHuman 之后，「Agent 执行 + 人类审批」表达不了，
           *   而计划页那一栏会显示成「🤖 Agent」，看不出后面还有一道闸。
           *
           * ★ requiresHuman 一并留着：老工作项只有它，读取处（executionModeOf）
           *   两个都认。等历史数据都带上 executionMode 之后再删。
           */
          executionMode: task.requiresHuman ? 'human' : 'auto',
          requiresHuman: task.requiresHuman,
          ...(task.operationType ? { operationType: task.operationType } : {}),
          ...(task.environment ? { environment: task.environment } : {}),
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
   * ★ 事件在事务**提交之后**发（modules/event/bus.ts 的纪律）。
   *   事务内发布会把「计划已生成」推给浏览器而事务随后回滚 ——
   *   用户点进去看到一个不存在的计划。
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
  const storedIds = new Set(scoped.map((p) => p.id));
  const baseline = BASELINE_POLICIES.filter((p) => !storedIds.has(p.id)).map((p) => ({
    ...p,
    orgId,
  }));
  return compile([
    ...baseline,
    ...scoped.map((r) => ({
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
  ]);
}

/**
 * Policy 预演 —— 把抽象规则翻译成「批准后会发生什么」。
 *
 * 页面文档 04 §5.3：批准计划 = 批准一批自动化行为，
 * 用户必须清楚看到自己让渡了什么，以及安全网在哪。
 */
/**
 * Policy 动作 → 「接下来系统会怎么办」的码。
 *
 * ★ 与 explainAction() 一一对应，但产出的是码而不是中文句子。
 *   explainAction 仍然保留 —— 它喂日志与通知，那里拼一句现成的话更省事。
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
     * ★ 认不出来的动作类型回落到「得有人处理」而不是「自动放行」。
     *   猜错方向的代价不对称：把「需要人」显示成「自动」会让用户以为
     *   不用管，而反过来只是多看一眼。
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
      externalFacing: false,
      environment: (task.environment as PolicyContext['environment']) ?? null,
      dataSensitivity: null,
      impactTaskCount: plan.tasks.filter((t) => t.dependsOn.some((d) => d.ref === task.ref)).length,
      impactServices: [],
      operationType: (task.operationType as PolicyContext['operationType']) ?? 'code_change',
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

  const totalTokens = plan.tasks.reduce((s, t) => s + (t.estimatedTokens ?? 0), 0);
  if (totalTokens > 0) {
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
): Promise<ApprovePlanResult> {
  const [plan] = await db.select().from(plans).where(eq(plans.id, input.planId));
  if (!plan) throw new Error(`计划不存在: ${input.planId}`);

  const [project] = await db.select().from(projects).where(eq(projects.id, plan.projectId));
  const estimated = (plan.estimatedTokens ?? 0);
  const budget = project?.tokenBudget ? project.tokenBudget : null;

  if (budget !== null && estimated > budget && !input.acknowledgedOverrun) {
    return { ok: false, code: 'BUDGET_EXCEEDED', estimated, budget };
  }

  const tasks = await db.select().from(workItems).where(eq(workItems.planId, plan.id));

  /**
   * ★ 在写 approved 之前判，不是之后 —— 拦下来的时候计划必须还是待批状态，
   *   否则用户补完执行者回来会发现计划已经批过了。
   */
  const unassignedHuman = tasks.filter(
    (t) => t.status === 'draft' && executionModeOf(t.typeData) === 'human' && !t.executorId,
  );
  if (unassignedHuman.length > 0 && !input.acknowledgedUnassigned) {
    return {
      ok: false,
      code: 'UNASSIGNED_HUMAN_TASKS',
      tasks: unassignedHuman.map((t) => ({ id: t.id, title: t.title })),
    };
  }

  await db
    .update(plans)
    .set({
      status: 'approved',
      approvedBy: [input.approverId],
      approvedAt: new Date(),
    })
    .where(eq(plans.id, plan.id));

  let activated = 0;
  for (const task of tasks) {
    if (task.status !== 'draft') continue;
    const moved = await transition(db, {
      workItemId: task.id,
      trigger: 'plan_approved',
      actor: humanActor(input.approverId),
      correlationId: input.correlationId,
    });
    if (moved.ok) activated++;
  }

  await emitAndPublish(db, {
    type: 'plan.approved',
    orgId: project!.orgId,
    projectId: plan.projectId,
    actor: humanActor(input.approverId),
    subjectType: 'plan',
    subjectId: plan.id,
    payload: {
      version: plan.version,
      approvers: [input.approverId],
      acknowledgedOverrun: input.acknowledgedOverrun ?? false,
      activatedTasks: activated,
      /** ★ 留痕：批准时有几项人工任务是没人认领就放行的 */
      unclaimedHumanTasks: unassignedHuman.length,
      // 批准时的自动化清单快照 —— 追溯「他到底批准了什么」
      autoActionsSnapshot: plan.autoActions,
    },
    correlationId: input.correlationId,
  });

  return {
    ok: true,
    planId: plan.id,
    activatedTasks: activated,
    unclaimed: unassignedHuman.length,
  };
}
