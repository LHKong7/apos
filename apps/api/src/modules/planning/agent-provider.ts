import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { agentRuns, agents, projectAgentBindings, projectMembers, type Database } from '@apos/db';
import type { RuntimeRegistry } from '@apos/agent-runtimes';
import type { AgentPermissions, RunEvent, RunWorkspace, TaskDispatch } from '@apos/contracts';
import { WorkspaceService } from '../workspace';
import { AgentPlanOutput, AgentStructuredOutput, validatePlanGraph } from './agent-output';
import { buildPlanBrief, buildStructureBrief, OUTPUT_FILE } from './agent-brief';
import type {
  GeneratedPlan,
  PlanningProvider,
  PlanningScope,
  StructureInput,
  StructuredRequirement,
} from './provider';

export interface AgentPlanningOptions {
  /** 工作区根目录，与 Agent 执行工作区同源（AGENT_WORKSPACE_ROOT） */
  root?: string;
  /** 单次规划的墙钟上限。★ 没有 supervisor 兜底，这里必须自己管 */
  timeoutMs?: number;
  /**
   * 复用进程里那一个 WorkspaceService。不给就自己建一个 ——
   * 空目录后端没有镜像锁之类的跨实例状态，建第二个不会出问题，
   * 但共用一个能让诊断输出汇到一处。
   */
  workspaces?: WorkspaceService;
  onDiagnostic?: (message: string, detail?: unknown) => void;
}

/** 规划 Agent 的判据：能处理 `requirement` 类型的工作项 */
const PLANNING_TYPE = 'requirement';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * 用真实 Agent 运行时做需求结构化与计划生成。
 *
 * ★★ 与执行 Run 的关系：**共用 agent_runs**，靠 kind 区分。
 *
 *   这一段以前写的是「刻意不共用」，理由是 work_item_id 为 NOT NULL、
 *   放开它要动 75 处消费点。实测下来那个数字是高估的：真正引用
 *   `agentRuns.workItemId` 的非测试代码只有 8 处，而且全是
 *   `where work_item_id = <某个真实 id>` —— NULL 行永远不匹配，
 *   规划 Run 因此不会串进看板、执行图与工作项的 Run 列表。
 *   放开之后由 TypeScript 逐个点出剩下的假设，一处不漏。
 *
 *   不共用的代价才是真的大：产品里最贵、最影响后续所有产出的那次调用，
 *   是唯一一次查不到的调用。
 *
 * ★ 仍然自己管超时（下面的 withTimeout），不交给 supervisor：
 *   supervisor 接管孤儿 Run 的动作（判失败、进恢复队列、按工作项找替补）
 *   在没有工作项的记录上一条都不成立，所以两条循环都显式排除 planning。
 *   代价写在这里免得当成遗漏：**进程重启后中断的规划 Run 会停在 running
 *   上没人收尾** —— 要治得给规划单独一条收尾循环。
 *
 * ★★ 任何一步出问题都回退到规则占位，并且**把真相写进 model 字段**。
 *
 *   这是整个类最重要的一条约束。在此之前界面上写着「🤖 AI 结构化结果」，
 *   而底下跑的是关键词正则 —— 用户拿回自己的原话换了三个标签，
 *   只会觉得「这 AI 真差」，不会想到根本没接模型。
 *   回退可以，但必须说出来。
 */
export class AgentPlanningProvider implements PlanningProvider {
  readonly name = 'agent';

  private workspaceService: WorkspaceService | null = null;

  private get workspaces(): WorkspaceService {
    this.workspaceService ??=
      this.options.workspaces ??
      new WorkspaceService(this.db, {
        ...(this.options.root === undefined ? {} : { root: this.options.root }),
        ...(this.options.onDiagnostic ? { onDiagnostic: this.options.onDiagnostic } : {}),
      });
    return this.workspaceService;
  }

  constructor(
    private readonly db: Database,
    private readonly registry: RuntimeRegistry,
    /** 兜底 —— 没配规划 Agent、运行时不可用、产物不合格时都走它 */
    private readonly fallback: PlanningProvider,
    private readonly options: AgentPlanningOptions = {},
  ) {}

  async structureRequirement(input: StructureInput): Promise<StructuredRequirement> {
    const attempt = await this.run({
      scope: input.scope,
      kind: 'structure',
      brief: buildStructureBrief(input),
      schema: AgentStructuredOutput,
    });

    if (!attempt.ok) {
      const base = await this.fallback.structureRequirement(input);
      return { ...base, model: degraded(base.model, attempt.reason) };
    }

    const out = attempt.value;
    return {
      title: out.title,
      businessContext: out.businessContext,
      userProblem: out.userProblem,
      businessGoal: out.businessGoal,
      userStories: out.userStories,
      scope: out.scope,
      nonFunctional: out.nonFunctional,
      successMetrics: out.successMetrics,
      constraints: out.constraints,
      risks: out.risks,
      acceptanceCriteria: out.acceptanceCriteria.map((c, i) => ({
        id: `ac-${i + 1}`,
        text: c.text,
        verification: c.verification,
        status: 'pending' as const,
        evidenceRef: null,
        verifiedAt: null,
      })),
      clarifications: out.clarifications,
      assumptions: out.assumptions,
      /**
       * ★ provenance 交空表而不是编一份。
       *   它撑的是需求页的原文对照高亮，而 Agent 给不出可信的字符偏移
       *   （它读到的是自己重写过的文本）。编出来的 span 会把高亮画在错的地方，
       *   比没有高亮更糟 —— 那会让用户以为「AI 说这句话来自这里」。
       */
      provenance: {},
      cost: attempt.costUsd,
      model: attempt.model,
    };
  }

  async generatePlan(
    req: StructuredRequirement,
    projectType: string,
    feedback?: string,
    scope?: PlanningScope,
  ): Promise<GeneratedPlan> {
    const started = Date.now();
    const attempt = await this.run({
      scope,
      kind: 'plan',
      brief: buildPlanBrief(req, projectType, feedback),
      schema: AgentPlanOutput,
      /** ★ schema 过了不等于图是自洽的 —— 悬空 ref 与环会静默毁掉调度 */
      check: (plan) => validatePlanGraph(plan),
    });

    if (!attempt.ok) {
      const base = await this.fallback.generatePlan(req, projectType, feedback, scope);
      return { ...base, model: degraded(base.model, attempt.reason) };
    }

    const out = attempt.value;
    return {
      tasks: out.tasks.map((t) => ({
        ref: t.ref,
        title: t.title,
        description: t.description,
        type: t.type,
        phase: t.phase,
        estimatedHours: t.estimatedHours,
        estimatedCost: t.estimatedCost,
        riskLevel: t.riskLevel,
        requiredSkills: t.requiredSkills,
        requiredTools: t.requiredTools,
        requiresHuman: t.requiresHuman,
        ...(t.operationType ? { operationType: t.operationType } : {}),
        ...(t.environment ? { environment: t.environment } : {}),
        acceptanceCriteria: t.acceptanceCriteria.map((c, i) => ({
          id: `${t.ref}-ac-${i + 1}`,
          text: c.text,
          verification: c.verification,
          status: 'pending' as const,
          evidenceRef: null,
          verifiedAt: null,
        })),
        dependsOn: t.dependsOn,
      })),
      milestones: out.milestones,
      risks: out.risks,
      cost: attempt.costUsd,
      durationMs: Date.now() - started,
      model: attempt.model,
    };
  }

  // ── 内部 ────────────────────────────────────────────────────────────

  private async run<T>(input: {
    scope: PlanningScope | undefined;
    kind: 'structure' | 'plan';
    brief: string;
    schema: { parse: (v: unknown) => T };
    check?: (value: T) => string[];
  }): Promise<Attempt<T>> {
    if (!input.scope) return fail('调用方没有给出 orgId/projectId，无法挑选规划 Agent');

    const picked = await this.pickAgent(input.scope);
    if (!picked.agent) return fail(picked.reason);
    const agent = picked.agent;
    if (!this.registry.has(agent.id)) {
      return fail(`Agent「${agent.name}」未在本进程注册（凭证缺失或运行时不可用）`);
    }

    const runId = randomUUID();
    const dir = join(this.root(), 'planning', runId);
    const model = `${agent.runtimeKind}:${agent.model ?? 'default'}`;

    /**
     * ★★ 规划也是一次真的 Agent 执行，必须留痕。
     *
     *   在此之前它只活在内存里：不出现在 Run 详情页与 Agent 视图、成本不进
     *   agent_runs 的统计、出问题时事后什么也查不到。也就是说，产品里最贵、
     *   最影响后续所有产出的那次调用，是唯一一次没有记录的调用。
     *
     *   现在它是 kind='planning' 的一行，work_item_id 为空（工作项这会儿
     *   还不存在 —— 那正是这一列被放开的原因）。
     */
    await this.openRun(runId, agent, input.scope, input.kind);

    /** 每一条失败路径都要落到那一行上，否则它会永远停在 dispatching */
    const failRun = async (reason: string): Promise<Attempt<T>> => {
      await this.closeRun(runId, 'failed', 0, reason);
      return fail(reason);
    };

    let acquired: Awaited<ReturnType<WorkspaceService['acquireLocal']>> | null = null;

    try {
      /**
       * ★ 走统一的工作区通道，而不是自己 mkdir 再手工捏一个 workspace 对象。
       *
       *   此前这里造的是 { repoRef:'planning', branch:'planning' } —— 一个
       *   假的 Git 工作区，于是 prompt 会对 Agent 说「你在分支 planning 上
       *   工作，它基于 planning」。现在它是一个如实的空目录工作区，
       *   vcs 为 null，prompt 换一套说法。
       *
       * ★ BRIEF.md 通过 seed 写入 —— 它必须算进**基线**。放在 acquire 之后
       *   写的话，平台自己的输入文件会出现在变更集的 added 里，被当成
       *   Agent 的产出。
       */
      acquired = await this.workspaces.acquireLocal({
        id: runId,
        runId,
        path: dir,
        /**
         * ★ 把任务书落成文件，而不是只塞进 prompt。
         *   这些 CLI 的强项就是读写文件 —— 给它一个能反复回看的 BRIEF.md，
         *   比把几千字塞进一次性的 prompt 更贴合它的工作方式，
         *   也让这次规划事后可复查（目录留着不删）。
         */
        seed: async (path) => {
          await writeFile(join(path, 'BRIEF.md'), input.brief, 'utf8');
        },
        /**
         * ★★ 把这个 Agent 被授权的项目资源**只读**挂进来。
         *
         *   在此之前规划 Run 只有一个空目录：写一份 BRIEF.md 进去、
         *   读一份 apos-output.json 出来。也就是说「分析这个项目的需求」时，
         *   Agent 手上没有这个项目的任何代码 —— 它只能照着需求原文编，
         *   而产出上写着「基于项目上下文」。
         *
         * ★ 只读：规划不该改代码。产出仍写在可写的主挂载里，两者分开。
         *   挂不上的资源不拖垮整次规划，但会在诊断里留痕（见 acquireLocal）。
         */
        readOnly: {
          orgId: input.scope.orgId,
          projectId: input.scope.projectId,
          scopes: agent.resourceScopes,
        },
      });

      const adapter = this.registry.get(agent.id);
      const task = this.buildDispatch(runId, agent, acquired.dispatch, input.brief);

      const ack = await adapter.dispatch(task);
      if (!ack.accepted) return failRun(`运行时拒绝任务：${ack.rejectReason ?? '未说明原因'}`);

      const outcome = await this.awaitRun(adapter, runId, agent.timeoutSeconds);
      if (!outcome.ok) return failRun(outcome.reason);

      const raw = await readFile(join(dir, OUTPUT_FILE), 'utf8').catch(() => null);
      if (raw === null) return failRun(`Agent 结束了但没有写出 ${OUTPUT_FILE}`);

      let parsed: T;
      try {
        parsed = input.schema.parse(JSON.parse(stripFence(raw)));
      } catch (err) {
        return failRun(`${OUTPUT_FILE} 不符合约定格式：${describe(err)}`);
      }

      const problems = input.check?.(parsed) ?? [];
      if (problems.length > 0) return failRun(`产出的计划不自洽：${problems.join('；')}`);

      this.diag(`[planning] ${input.kind} 由 ${agent.name} 完成，工作区 ${dir}`);
      await this.closeRun(runId, 'completed', outcome.costUsd, null);
      return { ok: true, value: parsed, model, costUsd: outcome.costUsd };
    } catch (err) {
      return failRun(describe(err));
    } finally {
      /**
       * ★ keep: true —— 目录留着供人事后复查（这是现有行为，规划失败时
       *   BRIEF.md 和 Agent 写了一半的东西是唯一的排查材料）。
       *   收尾要做的是清掉基线快照并把变更集记进诊断，不是删目录。
       */
      if (acquired) {
        const released = await this.workspaces
          .releaseLocal(
            acquired.workspace,
            {
              runId,
              outcome: 'completed',
              summary: `规划 ${input.kind}`,
              agentName: agent.name,
              goal: '需求规划',
            },
            { keep: true },
          )
          .catch((err) => {
            this.diag('[planning] 工作区收尾失败', err);
            return null;
          });
        if (released) this.diag(`[planning] ${runId} 产出：${released.published.note}`);
      }
    }
  }

  /**
   * 挑规划 Agent —— 先看项目**显式绑定**的那个。
   *
   * ★★ 在 project_agent_bindings 出现之前，这里是「组织里第一个
   *   status=active 且 applicableTypes 含 requirement 的 Agent」，按 createdAt 排序。
   *   三个后果：用户指定不了；想换只能去改另一个 Agent 的配置或建号顺序；
   *   而且它**完全不看项目成员关系** —— 组织里任何一个 Agent 都可能被拉来
   *   读这个项目的需求，而项目正是权限与上下文的边界。
   *
   * ★ 绑定优先，没绑定才回退到旧的「组织内自动挑」，并且**在回退时说出来**
   *   （reason 会一路进到 model 字段里，见类文档那条纪律）。直接报错的话，
   *   所有还没来得及配绑定的既有项目会在下一次分析时全部失败。
   *
   * ★ 回退挑出来的也必须是本项目成员 —— 这一条比绑定与否更靠前：
   *   它是授权，不是偏好。
   */
  private async pickAgent(
    scope: PlanningScope,
  ): Promise<{ agent: typeof agents.$inferSelect | null; reason: string }> {
    const [bound] = await this.db
      .select({ agent: agents })
      .from(projectAgentBindings)
      .innerJoin(agents, eq(agents.id, projectAgentBindings.agentId))
      .where(
        and(
          eq(projectAgentBindings.projectId, scope.projectId),
          eq(projectAgentBindings.role, 'planner'),
        ),
      );

    if (bound) {
      if (bound.agent.status !== 'active') {
        return {
          agent: null,
          reason: `项目绑定的规划 Agent「${bound.agent.name}」当前状态是 ${bound.agent.status}`,
        };
      }
      if (!bound.agent.applicableTypes.includes(PLANNING_TYPE)) {
        return {
          agent: null,
          reason: `项目绑定的规划 Agent「${bound.agent.name}」的适用类型里没有 ${PLANNING_TYPE}`,
        };
      }
      return { agent: bound.agent, reason: '' };
    }

    const members = await this.db
      .select({ actorId: projectMembers.actorId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, scope.projectId),
          eq(projectMembers.actorType, 'agent'),
        ),
      );
    if (members.length === 0) {
      return {
        agent: null,
        reason: '这个项目还没有绑定规划 Agent，项目成员里也没有任何 Agent',
      };
    }

    const [row] = await this.db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.orgId, scope.orgId),
          eq(agents.status, 'active'),
          inArray(agents.id, members.map((m) => m.actorId)),
          sql`${agents.applicableTypes} @> ARRAY[${PLANNING_TYPE}]::work_item_type[]`,
        ),
      )
      .orderBy(agents.createdAt)
      .limit(1);

    if (!row) {
      return {
        agent: null,
        reason: `这个项目还没有绑定规划 Agent，成员里也没有适用于 ${PLANNING_TYPE} 的可用 Agent`,
      };
    }
    return { agent: row, reason: '' };
  }

  /**
   * 开一条规划 Run 记录。
   *
   * ★ 与执行 Run 走**同一张表**，靠 kind 区分 —— 而不是再建一张
   *   planning_runs。Agent 视图上「这个 Agent 最近干了什么」要能同时看到
   *   两类，分两张表的话每个消费点都得 union 一次。
   *
   * ★ idempotencyKey 用 runId：规划不像派发那样会被网络重试打两次
   *   （调用方是进程内的 await），但这一列是 NOT NULL 且唯一，
   *   给一个天然唯一的值比留空更诚实。
   */
  private async openRun(
    runId: string,
    agent: typeof agents.$inferSelect,
    scope: PlanningScope,
    kind: 'structure' | 'plan',
  ): Promise<void> {
    await this.db.insert(agentRuns).values({
      id: runId,
      orgId: scope.orgId,
      projectId: scope.projectId,
      // ★ 工作项这会儿还不存在 —— 这正是 work_item_id 被放开成可空的原因
      workItemId: null,
      kind: 'planning',
      agentId: agent.id,
      status: 'dispatching',
      idempotencyKey: runId,
      goal: kind === 'structure' ? '需求结构化' : '生成计划',
      model: agent.model,
      startedAt: new Date(),
    });
  }

  /** 收尾那一行。失败时把原因写进 errorSummary，事后查得到 */
  private async closeRun(
    runId: string,
    status: 'completed' | 'failed',
    costUsd: number,
    reason: string | null,
  ): Promise<void> {
    await this.db
      .update(agentRuns)
      .set({
        status,
        cost: String(costUsd),
        endedAt: new Date(),
        ...(reason === null ? {} : { errorMessage: reason, errorClass: 'runtime_error' }),
      })
      .where(eq(agentRuns.id, runId))
      .catch(() => undefined);
  }

  private buildDispatch(
    runId: string,
    agent: typeof agents.$inferSelect,
    workspace: RunWorkspace,
    brief: string,
  ): TaskDispatch {
    const permissions: AgentPermissions = {
      allowedTools: agent.allowedTools,
      deniedTools: agent.deniedTools,
      resourceScopes: agent.resourceScopes,
    };

    return {
      runId,
      idempotencyKey: `planning:${runId}`,
      agent: {
        name: agent.name,
        type: agent.type,
        description: agent.description,
        skills: agent.skills,
      },
      /**
       * ★ 一个空目录工作区，不是 git 工作树。
       *   规划不需要仓库：它读的是需求原文，写的是一份 JSON。
       *   真去 clone 一个仓库只会让规划多等几十秒。
       */
      workspace,
      goal: {
        title: '需求规划',
        description: brief,
        acceptanceCriteria: [
          { id: 'ac-output', text: `在工作目录下写出符合约定格式的 ${OUTPUT_FILE}` },
        ],
        constraints: [],
      },
      context: [],
      permissions,
      limits: {
        maxCostUsd: Number(agent.costLimitPerRun ?? 5),
        maxDurationSeconds: agent.timeoutSeconds,
        maxTokens: null,
      },
      model: agent.model,
      /**
       * ★ 回调地址是给执行 Run 用的 —— 规划 Run 不在 agent_runs 里，
       *   那个端点会找不到它。这里靠 subscribe 直接收事件，
       *   给一个明确无效的地址比给一个会 404 的真地址更清楚。
       */
      callback: { eventsUrl: 'inline://planning', token: runId },
    };
  }

  /** 订阅到 run_ended 为止，顺带累计成本。超时自己管 —— 没有 supervisor */
  private async awaitRun(
    adapter: ReturnType<RuntimeRegistry['get']>,
    runId: string,
    agentTimeoutSeconds: number,
  ): Promise<{ ok: true; costUsd: number } | { ok: false; reason: string }> {
    const budgetMs = Math.min(
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      agentTimeoutSeconds * 1000,
    );

    let costUsd = 0;
    let settle: (r: { ok: true; costUsd: number } | { ok: false; reason: string }) => void;
    const done = new Promise<{ ok: true; costUsd: number } | { ok: false; reason: string }>(
      (r) => (settle = r),
    );

    const unsubscribe = await adapter.subscribe(runId, async (e: RunEvent) => {
      if (e.type === 'cost') costUsd = e.totalUsd;
      if (e.type === 'error') this.diag(`[planning] ${runId} 报错`, e.error);
      if (e.type === 'run_ended') {
        settle(
          e.outcome === 'completed'
            ? { ok: true, costUsd }
            : { ok: false, reason: `Agent 以 ${e.outcome} 结束：${e.summary}` },
        );
      }
    });

    const timer = setTimeout(
      () => settle({ ok: false, reason: `规划超过 ${Math.round(budgetMs / 1000)}s 未结束` }),
      budgetMs,
    );

    try {
      return await done;
    } finally {
      clearTimeout(timer);
      // Unsubscribe 允许同步返回，不能直接 .catch
      await Promise.resolve(unsubscribe()).catch(() => {});
      /**
       * ★ 超时后要主动终止，否则那个 CLI 子进程会继续跑到自己的上限 ——
       *   一次超时留下一个还在烧钱的孤儿进程，而没有任何地方看得到它。
       */
      await adapter.control(runId, { action: 'terminate', reason: '规划超时' }).catch(() => {});
    }
  }

  private root(): string {
    return resolve(this.options.root ?? process.env['AGENT_WORKSPACE_ROOT'] ?? '/tmp/apos-workspaces');
  }

  private diag(message: string, detail?: unknown) {
    this.options.onDiagnostic?.(message, detail);
  }
}

type Attempt<T> =
  | { ok: true; value: T; model: string; costUsd: number }
  | { ok: false; reason: string };

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/**
 * 回退时把原因编进 model 字段。
 *
 * ★ 这个字符串会一路显示到计划页与需求页上。它是用户唯一能知道
 *   「这次不是真 Agent 干的」的渠道 —— 所以宁可难看，也要说清楚。
 */
function degraded(baseModel: string, reason: string): string {
  return `${baseModel}（规则占位，未走 Agent：${reason}）`;
}

/** LLM 爱把 JSON 包在 ```json 里。与其让它去改习惯，不如这里剥一层 */
function stripFence(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return (fenced?.[1] ?? raw).trim();
}

/**
 * ★ ZodError 的 message 是一整坨 JSON。这个字符串会一路显示到需求页上，
 *   甩一段 issue 数组给用户等于什么都没说 —— 压成「字段路径: 原因」的短句。
 */
function describe(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '根对象'} ${i.message}`)
      .join('；');
  }
  return err instanceof Error ? err.message : String(err);
}
