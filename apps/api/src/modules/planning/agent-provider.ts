import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { ZodError } from 'zod';
import {
  agentRuns,
  agents,
  projectAgentBindings,
  projectMembers,
  runEvents,
  type Database,
} from '@apos/db';
import { usdCeilingForTokens, type RuntimeRegistry } from '@apos/agent-runtimes';
import type {
  AgentPermissions,
  PlanFallbackCode,
  RunEvent,
  RunWorkspace,
  TaskDispatch,
} from '@apos/contracts';
import type { EffectiveAgentAccess } from '@apos/domain';
import { resolveAgentAccess } from '../agent/access';
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

/**
 * 一行摘要 —— run_events.summary 是 NOT NULL，而 Run 详情页的简明模式只读它。
 *
 * ★ 不复用 ingest 里那个 summarize：那个是给执行 Run 写的，措辞围绕
 *   工作项与交付展开，用在规划上会说出「已提交到分支」这类根本没发生的事。
 */
function planningEventSummary(e: RunEvent): string {
  switch (e.type) {
    case 'run_started':
      return '规划开始';
    case 'run_ended':
      return `规划结束：${e.outcome}`;
    case 'cost':
      return `累计成本 $${e.totalUsd}`;
    case 'error':
      return `报错：${typeof e.error === 'string' ? e.error : JSON.stringify(e.error)}`;
    case 'progress':
      return e.totalSteps ? `${e.description}（${e.step}/${e.totalSteps}）` : e.description;
    default:
      return e.type;
  }
}

/**
 * 自动挑选时**优先**考虑的适用类型 —— 注意是偏好，不是门槛。
 *
 * ★★ `applicableTypes` 回答的是「派工作项时能不能派给它」
 *   （domain/flow/matching.ts 里那条 `applicableTypes.includes(target.type)`），
 *   而写 PRD 根本不经过派工：这会儿工作项还不存在，那正是
 *   `agent_runs.work_item_id` 被放开成可空的原因。拿它当门槛是把两件事
 *   混成了一件，代价是项目里明明有一队 Agent，能写 PRD 的却是零个 ——
 *   而用户在需求页上看到的是一个空下拉框，没有任何线索说明为什么。
 *
 *   所以现在：**项目 Agent 成员都能写 PRD**，这个类型只用来给自动挑选
 *   排个先后。人点了名的那个一律照办（见 pickAgent）。
 *
 *   `applicableTypes` answers "can this agent be *assigned* a work item of
 *   type X" — PRD authoring dispatches no work item at all, so gating on it
 *   conflated two things and left projects with a full agent team and zero
 *   eligible PRD authors. Any project agent member can author now; this type
 *   only orders the automatic pick.
 */
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
      return {
        ...base,
        model: degraded(base.model, attempt.reason),
        fallback: { code: attempt.code, reason: attempt.reason },
      };
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
      fallback: null,
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
      brief: buildPlanBrief(req, projectType, feedback, scope?.locale),
      schema: AgentPlanOutput,
      /** ★ schema 过了不等于图是自洽的 —— 悬空 ref 与环会静默毁掉调度 */
      check: (plan) => validatePlanGraph(plan),
    });

    if (!attempt.ok) {
      const base = await this.fallback.generatePlan(req, projectType, feedback, scope);
      return {
        ...base,
        model: degraded(base.model, attempt.reason),
        fallback: { code: attempt.code, reason: attempt.reason },
      };
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
        estimatedTokens: t.estimatedTokens,
        riskLevel: t.riskLevel,
        requiredSkills: t.requiredSkills,
        requiredCapabilities: t.requiredCapabilities,
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
      fallback: null,
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
    if (!input.scope) return fail('no_scope', '调用方没有给出 orgId/projectId，无法挑选规划 Agent');

    const picked = await this.pickAgent(input.scope);
    if (!picked.agent) return fail('no_agent', picked.reason);
    const agent = picked.agent;
    if (!this.registry.has(agent.id)) {
      return fail(
        'agent_unregistered',
        `Agent「${agent.name}」未在本进程注册（凭证缺失或运行时不可用）`,
      );
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
    await this.openRun(runId, agent, input.scope, input.kind, input.scope.requirementId ?? null);

    /** 每一条失败路径都要落到那一行上，否则它会永远停在 dispatching */
    const failRun = async (code: PlanFallbackCode, reason: string): Promise<Attempt<T>> => {
      await this.closeRun(runId, 'failed', 0, reason);
      return fail(code, reason);
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
      /**
       * ★★ 规划 Run 的权限同样按**项目**求值，与执行 Run 走同一个函数。
       *
       *   此前这里直接读 agents 表上那份组织级的 resourceScopes / allowedTools。
       *   两条派发路径各读各的，意味着「这个 Agent 能读哪些仓库」在规划与
       *   执行时可以是两个答案 —— 而规划恰恰是最贵、最影响后续所有产出的
       *   那次调用。
       *
       * Planning runs resolve access through the same evaluator as execution
       * runs. Reading the org-level fields here meant "which repositories may
       * this agent read" had two answers depending on which path dispatched it.
       */
      const access = await resolveAgentAccess(this.db, agent, {
        orgId: input.scope.orgId,
        projectId: input.scope.projectId,
      });

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
          scopes: access.runtimePermissions.resourceScopes,
        },
      });

      const adapter = this.registry.get(agent.id);
      const task = this.buildDispatch(runId, agent, acquired.dispatch, input.brief, access);

      const ack = await adapter.dispatch(task);
      if (!ack.accepted) {
        return failRun('runtime_rejected', `运行时拒绝任务：${ack.rejectReason ?? '未说明原因'}`);
      }

      const outcome = await this.awaitRun(adapter, runId, agent.timeoutSeconds);
      if (!outcome.ok) return failRun('run_failed', outcome.reason);

      const raw = await readFile(join(dir, OUTPUT_FILE), 'utf8').catch(() => null);
      if (raw === null) return failRun('output_missing', `Agent 结束了但没有写出 ${OUTPUT_FILE}`);

      let parsed: T;
      try {
        parsed = input.schema.parse(JSON.parse(stripFence(raw)));
      } catch (err) {
        return failRun('output_invalid', `${OUTPUT_FILE} 不符合约定格式：${describe(err)}`);
      }

      const problems = input.check?.(parsed) ?? [];
      if (problems.length > 0) {
        return failRun('output_inconsistent', `产出的计划不自洽：${problems.join('；')}`);
      }

      this.diag(`[planning] ${input.kind} 由 ${agent.name} 完成，工作区 ${dir}`);
      await this.closeRun(runId, 'completed', outcome.costUsd, null);
      return { ok: true, value: parsed, model, costUsd: outcome.costUsd };
    } catch (err) {
      return failRun('unexpected_error', describe(err));
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
   * 这个 Agent 现在能不能干规划活；能就返回 null，不能就返回**一句能直接
   * 念给用户听的原因**。
   *
   * ★ 抽出来是因为「点名的那个」与「绑定的那些」要走**同一套**判据。
   *   两处各写一遍的话，迟早出现「绑定路径拦得住、点名路径拦不住」——
   *   而点名路径恰恰是用户输入直接决定的那一条。
   *
   *   Whether this agent can take planning work right now; null when it can,
   *   otherwise a reason phrased for the user. Shared deliberately: the
   *   explicitly named agent and the bound ones must be judged identically.
   */
  private unusableReason(agent: typeof agents.$inferSelect): string | null {
    if (agent.status !== 'active') return agent.status;
    /**
     * ★ 这里**不再**卡 applicableTypes。理由见 PLANNING_TYPE 上的那段：
     *   它是派工作项的判据，不是「能不能写 PRD」的判据。留在这里的话，
     *   需求页上刚放开的选择会在分析这一刻被否掉 —— 校验从「选的时候」
     *   推迟到「等结果的时候」，是这个功能最不该有的表现。
     *
     *   Deliberately no applicableTypes gate: it decides work-item dispatch,
     *   not PRD authorship. Keeping it here would veto at analysis time the
     *   very pick the requirement page just accepted.
     */
    if (!this.registry.has(agent.id)) return '运行时未注册';
    return null;
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
   * ★★ 候选是**项目的 Agent 成员**，全体，不按适用类型筛。
   *   写 PRD 不是派工作项，applicableTypes 在这一条路上只排先后
   *   （见 PLANNING_TYPE）。授权边界仍然是成员关系，一道不减。
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
    /**
     * ★★ 用户在需求页上点了名 —— 这一条压过项目绑定，而且**没有备选**。
     *
     *   退到别人身上是这里唯一不能做的事：绑定路径退到备选是「系统替你
     *   兜底」，而点名路径退到别人是「系统否决了你的选择还不告诉你」。
     *   所以不可用时返回 null + 原因，让这次分析如实回退到规则占位，
     *   原因一路写进 analysisModel，需求页上就摆在结果标题旁边。
     *
     * ★ 授权检查一道不减，而且**排在可用性之前**：不是本项目成员的 Agent
     *   连「不可用」都不该被谈论 —— 项目是权限与上下文的边界，
     *   而这个 id 是从 HTTP 请求一路传下来的。
     */
    if (scope.agentId) {
      const [named] = await this.db
        .select()
        .from(agents)
        .where(and(eq(agents.id, scope.agentId), eq(agents.orgId, scope.orgId)));
      if (!named) {
        return { agent: null, reason: '需求上指定的 PRD 编写 Agent 已不存在' };
      }

      const [member] = await this.db
        .select({ actorId: projectMembers.actorId })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, scope.projectId),
            eq(projectMembers.actorType, 'agent'),
            eq(projectMembers.actorId, named.id),
          ),
        );
      if (!member) {
        return {
          agent: null,
          reason: `需求上指定的 Agent「${named.name}」已不是这个项目的成员`,
        };
      }

      const why = this.unusableReason(named);
      return why
        ? { agent: null, reason: `需求上指定的 Agent「${named.name}」现在不可用：${why}` }
        : { agent: named, reason: '' };
    }

    /**
     * ★★ 按 priority 顺着往下退，而不是只看主 Agent。
     *
     *   只有主 Agent 时，它一停用整个项目的规划就断了，唯一补救是管理员
     *   去改绑定 —— 而那通常发生在有人等着结果的时候。备选让它能自己
     *   退一格继续跑，并把「为什么没用主的」说出来。
     */
    const bound = await this.db
      .select({ agent: agents, priority: projectAgentBindings.priority })
      .from(projectAgentBindings)
      .innerJoin(agents, eq(agents.id, projectAgentBindings.agentId))
      .where(
        and(
          eq(projectAgentBindings.projectId, scope.projectId),
          eq(projectAgentBindings.role, 'planner'),
        ),
      )
      .orderBy(asc(projectAgentBindings.priority));

    if (bound.length > 0) {
      const skipped: string[] = [];
      for (const row of bound) {
        const why = this.unusableReason(row.agent);
        if (why) {
          skipped.push(`${row.agent.name}（${why}）`);
          continue;
        }
        /**
         * ★ 退到备选时要说出来。不说的话，用户看到的产出来自一个他没指定的
         *   Agent，而界面上一切正常 —— 规划质量突然变了却查不到原因。
         */
        if (skipped.length > 0) {
          this.diag(
            `[planning] 主规划 Agent 不可用（${skipped.join('、')}），退到备选「${row.agent.name}」`,
          );
        }
        return { agent: row.agent, reason: '' };
      }
      return {
        agent: null,
        reason: `项目绑定的规划 Agent 都不可用：${skipped.join('、')}`,
      };
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

    const candidates = await this.db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.orgId, scope.orgId),
          eq(agents.status, 'active'),
          inArray(agents.id, members.map((m) => m.actorId)),
        ),
      )
      .orderBy(agents.createdAt);

    if (candidates.length === 0) {
      return {
        agent: null,
        reason: '这个项目还没有绑定规划 Agent，成员里也没有启用中的 Agent',
      };
    }

    /**
     * ★★ 「适用类型含 requirement」在这里是**排序偏好**，不是过滤条件。
     *
     *   以前它是一条 SQL where：一个项目哪怕有五个 Agent 成员，只要没人
     *   勾过 requirement，自动挑就返回空，分析直接退成规则占位 —— 而那
     *   五个 Agent 里任何一个都写得了 PRD。现在勾过的排在前面，没勾过的
     *   照样能被挑中。
     *
     * ★ 先按「现在可用」分层，再按偏好挑：反过来的话，会挑中一个勾了
     *   requirement 但运行时没注册的，而旁边就站着一个跑得动的。
     *   一个都不可用时退回整份名单，好让 run() 报出那条具体的原因，
     *   而不是含混的「没有可用 Agent」。
     *
     *   Preference, not filter: agents declaring `requirement` sort first, but
     *   any active project agent member can be picked. Usability is layered
     *   ahead of preference so a declared-but-unregistered agent never beats a
     *   runnable one.
     */
    const usable = candidates.filter((a) => this.unusableReason(a) === null);
    const pool = usable.length > 0 ? usable : candidates;
    const row = pool.find((a) => a.applicableTypes.includes(PLANNING_TYPE)) ?? pool[0]!;

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
    requirementId: string | null,
  ): Promise<void> {
    await this.db.insert(agentRuns).values({
      id: runId,
      orgId: scope.orgId,
      projectId: scope.projectId,
      // ★ 工作项这会儿还不存在 —— 这正是 work_item_id 被放开成可空的原因
      workItemId: null,
      kind: 'planning',
      // ★ 没有它，这条 Run 查得到却找不回来 —— 需求页上没有任何入口指向它
      requirementId,
      agentId: agent.id,
      status: 'dispatching',
      idempotencyKey: runId,
      /**
       * ★★ 规划 Run 的 goal 存**码**，不存中文句子。
       *
       *   这一行会出现在英文界面上（需求页的「Analysis runs」），而一句中文
       *   在那里就是一段读不懂的字。规划 Run 的 goal 只有两种取值，正是
       *   「该用码」的典型：句子只服务中文界面，码同时服务两种语言。
       *
       * ★ 为什么放在 `goal` 而不是另起一栏：这一栏的含义本来就是
       *   「这次 Run 是要干什么」。执行 Run 往里放的是工作项标题（用户内容），
       *   规划 Run 放平台自己的码 —— 界面按 `kind` 区分，两者不会撞。
       *
       *   ★★ 特别不能放进 `inputContext`：那一栏是**数组**
       *   （TaskDispatch['context']，每项有 kind/ref/title/priority），
       *   Run 详情页对它做 `.length` 与 `.map()`。塞一个对象进去，
       *   任何一次规划 Run 的详情页都会当场崩掉。
       *
       *   Planning runs store the code here; execution runs store the work item
       *   title. The UI tells them apart by `kind`.
       */
      goal: kind === 'structure' ? 'structure' : 'plan',
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
    access: EffectiveAgentAccess,
  ): TaskDispatch {
    /** ★ 下发的是求值结果，不是 Agent 上那份组织级旧字段 */
    const permissions: AgentPermissions = access.runtimePermissions;

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
      /**
       * ★ 规划 Run 没有 Policy 闸门，空数组是结论不是遗漏。
       *   Policy 评估挂在 Work Item 的状态流转上，而规划跑在建出工作项**之前**
       *   —— 它没有可流转的对象。规划产出的把关走的是另一条路：计划审批
       *   （`plan.approved`）。在这里编一份警告只会让 Agent 去防一道
       *   它这辈子都碰不到的闸门。
       *
       * Planning runs have no policy gates; the empty array is a conclusion,
       * not an oversight. Policy is evaluated on work-item transitions, and
       * planning runs before any work item exists. Planning output is gated by
       * plan approval instead.
       */
      policyGates: [],
      limits: {
        maxTokens: agent.tokenLimitPerRun,
        maxCostUsd: usdCeilingForTokens(agent.model, agent.tokenLimitPerRun),
        maxDurationSeconds: agent.timeoutSeconds,
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
      /**
       * ★★ 事件要落库，不能只在内存里过一遍。
       *
       *   规划 Run 现在是一条真的 agent_runs 记录，Run 详情页照着 run_events
       *   渲染时间线与成本明细。事件不落库的话，那一页对规划 Run 是空的 ——
       *   「这次分析到底做了什么」还是查不到，可审计只做了一半。
       *
       * ★ 落库失败不影响这次规划：进度是附加信息，为它中断一次已经跑起来的
       *   分析不划算。
       */
      await this.db
        .insert(runEvents)
        .values({
          runId,
          seq: e.seq,
          ts: new Date(e.ts),
          type: e.type,
          level: 'detail',
          summary: planningEventSummary(e),
          payload: e as unknown as Record<string, unknown>,
          costDelta: e.type === 'cost' ? String(e.deltaUsd) : null,
        })
        .onConflictDoNothing()
        .catch(() => undefined);

      // ★ 心跳跟着走，Run 详情页才能显示「还活着」
      await this.db
        .update(agentRuns)
        .set({ lastHeartbeatAt: new Date(), ...(e.type === 'cost' ? { cost: String(e.totalUsd) } : {}) })
        .where(eq(agentRuns.id, runId))
        .catch(() => undefined);

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
  | { ok: false; reason: string; code: PlanFallbackCode };

/**
 * ★ 每条失败路径都要带上码。
 *
 *   码决定界面怎么做（禁掉自动化承诺、给哪个修复入口），
 *   reason 只是给日志和排查看的那句细节。少给码的代价是
 *   界面只能回落到「不知道为什么，反正不可信」那一档。
 */
function fail(code: PlanFallbackCode, reason: string): { ok: false; reason: string; code: PlanFallbackCode } {
  return { ok: false, reason, code };
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
