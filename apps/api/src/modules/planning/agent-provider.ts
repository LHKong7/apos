import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
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
  ErrorClass,
  PlanFallbackCode,
  RunEvent,
  RunWorkspace,
  TaskDispatch,
} from '@apos/contracts';
import { totalTokens } from '@apos/contracts';
import type { EffectiveAgentAccess } from '@apos/domain';
import { resolveAgentAccess } from '../agent/access';
import { WorkspaceService } from '../workspace';
import { AgentPlanOutput, AgentStructuredOutput, validatePlanGraph } from './agent-output';
import { buildPlanBrief, buildRepairBrief, buildStructureBrief, OUTPUT_FILE } from './agent-brief';
import type {
  GeneratedPlan,
  PlanningProvider,
  PlanningScope,
  StructureInput,
  StructuredRequirement,
} from './provider';

export interface AgentPlanningOptions {
  /** Workspace root, the same one agent execution workspaces use (AGENT_WORKSPACE_ROOT). */
  root?: string;
  /** Wall-clock ceiling for one planning attempt. ★ No supervisor backstop — this must self-police. */
  timeoutMs?: number;
  /**
   * Reuse the one WorkspaceService in this process. Build our own when none is
   * given — the empty-directory backend keeps no cross-instance state (no mirror
   * locks), so a second instance breaks nothing, but sharing one funnels every
   * diagnostic into a single place.
   *
   * 复用进程里那一个 WorkspaceService。不给就自己建一个 —— 空目录后端没有镜像锁
   * 之类的跨实例状态，建第二个不会出问题，但共用一个能让诊断输出汇到一处。
   */
  workspaces?: WorkspaceService;
  onDiagnostic?: (message: string, detail?: unknown) => void;
}

/**
 * One-line summary — run_events.summary is NOT NULL, and the run detail page's
 * concise mode reads nothing but that column.
 *
 * ★ Deliberately not the `summarize` from ingest: that one is written for
 *   execution runs and phrased around work items and deliverables, so on a
 *   planning run it announces things like "pushed to the branch" that never
 *   happened.
 *
 *   不复用 ingest 里那个 summarize：它的措辞围绕工作项与交付展开，
 *   用在规划上会说出根本没发生的事。
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
    case 'delivery_validation':
      return e.summary;
    default:
      return e.type;
  }
}

/**
 * The applicable type the automatic pick **prefers** — a preference, not a gate.
 *
 * ★★ `applicableTypes` answers "can this agent be *assigned* a work item of
 *   type X" (`applicableTypes.includes(target.type)` in domain/flow/matching.ts),
 *   and authoring a PRD dispatches no work item at all: none exists yet, which
 *   is exactly why `agent_runs.work_item_id` was widened to nullable. Gating on
 *   it conflated two things, and the cost was a project holding a full agent
 *   team with zero eligible PRD authors — while the user saw an empty dropdown
 *   on the requirement page and no hint as to why.
 *
 *   So now: **every project agent member can author a PRD**, and this type only
 *   orders the automatic pick. An explicitly named agent is always honored
 *   (see pickAgent).
 *
 *   自动挑选时优先考虑的适用类型 —— 是偏好，不是门槛。它回答的是「派工作项
 *   时能不能派给它」，而写 PRD 根本不经过派工。拿它当门槛的代价是项目里明明
 *   有一队 Agent，能写 PRD 的却是零个。现在项目 Agent 成员都能写，人点了名
 *   的一律照办。
 */
const PLANNING_TYPE = 'requirement';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * How many rounds one planning attempt may take, first round included.
 *
 * ★ Two, not three. Round two hands the model zod's own words back; what it
 *   still gets wrong after that is rarely the "look again and you'll see it"
 *   kind of mistake — and every extra round costs the user another full agent
 *   execution of waiting plus another round of spend. All of the recoverable
 *   value sits in round two.
 *
 *   是 2 不是 3。每多一轮，用户就多等一次完整的 Agent 执行，成本也多一份，
 *   而真正救得回来的收益全在第二轮。
 */
const MAX_PLANNING_ROUNDS = 2;

/**
 * Failure codes worth another round.
 *
 * ★★ The test is "given more information, could the same agent produce a
 *   different result?" A rejected artifact qualifies: the error names the field
 *   and says what is wrong with it, and fixing that is within the model's reach.
 *   A missing output file also qualifies: the runtime completed successfully,
 *   so the model was reachable, and the repair brief can explicitly point out
 *   that it failed the delivery protocol. Runtime refusal and timeout do not
 *   qualify — no extra instruction can repair those.
 *
 *   判据是「同一个 Agent 拿着更多信息再跑一次，结果可能不一样吗」。产物不合格
 *   属于这一类；运行成功但漏写文件也能用明确的交付提醒纠正。挑不到 Agent、
 *   运行时拒收、超时则不是。
 */
const REPAIRABLE_CODES = new Set<PlanFallbackCode>([
  'output_missing',
  'output_invalid',
  'output_inconsistent',
]);

function planningErrorClass(code: PlanFallbackCode): ErrorClass {
  switch (code) {
    case 'output_missing':
      return 'output_missing';
    case 'output_invalid':
    case 'output_inconsistent':
      return 'invalid_task';
    case 'no_scope':
      return 'context_insufficient';
    case 'no_agent':
    case 'agent_unregistered':
      return 'capability_mismatch';
    case 'runtime_rejected':
    case 'run_failed':
    case 'unexpected_error':
      return 'runtime_error';
  }
}

/**
 * Requirement structuring and plan generation on a real agent runtime.
 *
 * ★★ Relationship to execution runs: **agent_runs is shared**, told apart by
 *   `kind`.
 *
 *   This paragraph used to say the two were deliberately kept apart, on the
 *   grounds that work_item_id was NOT NULL and widening it would touch 75
 *   consumers. Measured, that number was an overestimate: only 8 non-test sites
 *   read `agentRuns.workItemId`, and every one of them reads
 *   `where work_item_id = <some real id>` — a NULL row never matches, so
 *   planning runs cannot leak into the board, the execution graph, or a work
 *   item's run list. Once the column was widened, TypeScript pointed out every
 *   remaining assumption, one by one, missing none.
 *
 *   Not sharing is what costs: the most expensive call in the product, the one
 *   every later artifact is built on, would be the only call nobody can look up
 *   afterward.
 *
 * ★ Timeouts are still handled here (withTimeout below) rather than handed to
 *   the supervisor: everything the supervisor does with an orphaned run — mark
 *   it failed, queue it for recovery, find a substitute by work item — is
 *   meaningless on a row that has no work item, so both loops exclude planning
 *   explicitly. The price is written down here so it is not mistaken for an
 *   oversight: **a planning run interrupted by a process restart sits in
 *   `running` with nobody to close it** — fixing that needs a reaper loop of
 *   its own for planning.
 *
 * ★★ A problem at any step falls back to the rule-based placeholder, and
 *   **the truth is written into the model field**.
 *
 *   This is the most important constraint in the class. Before it, the UI said
 *   "🤖 AI structured result" while a keyword regex ran underneath — the user
 *   got their own words back with three labels attached, concluded "this AI is
 *   terrible", and never suspected no model had been called at all. Falling
 *   back is fine; falling back silently is not.
 *
 *   与执行 Run 共用 agent_runs，靠 kind 区分 —— 不共用的代价是产品里最贵的
 *   那次调用是唯一查不到的调用。超时仍然自己管，supervisor 那套动作在没有
 *   工作项的记录上一条都不成立，代价是进程重启后中断的规划 Run 会停在
 *   running 上没人收尾。任何一步出问题都回退到规则占位，并把真相写进 model
 *   字段：回退可以，但必须说出来。
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
    /**
     * Fallback — taken when no planning agent is configured, when the runtime is
     * unavailable, and when the artifact is rejected.
     */
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
       * ★ Hand back an empty provenance map instead of inventing one.
       *   It backs the requirement page's side-by-side highlighting against the
       *   original text, and an agent cannot produce trustworthy character
       *   offsets — what it read is its own rewritten text. Invented spans paint
       *   the highlight in the wrong place, which is worse than no highlight at
       *   all: the user reads it as "the AI says this sentence came from here".
       *
       *   编出来的 span 会把高亮画在错的地方，比没有高亮更糟。
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
      /**
       * ★ Passing the schema does not make the graph coherent — dangling refs
       *   and cycles wreck scheduling silently.
       */
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
        ...(t.dataSensitivity ? { dataSensitivity: t.dataSensitivity } : {}),
        ...(t.externalFacing !== undefined ? { externalFacing: t.externalFacing } : {}),
        acceptanceCriteria: t.acceptanceCriteria.map((c, i) => ({
          id: `${t.ref}-ac-${i + 1}`,
          text: c.text,
          ...(c.requirementCriterionId &&
          req.acceptanceCriteria.some((criterion) => criterion.id === c.requirementCriterionId)
            ? { requirementCriterionId: c.requirementCriterionId }
            : {}),
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

  // ── Internals ───────────────────────────────────────────────────────

  /**
   * One planning attempt = at most two rounds.
   *
   * ★★ There used to be exactly one round: a rejected artifact discarded the
   *   whole attempt and fell straight back to the rule-based placeholder — even
   *   though `agent-output.ts` claimed "rejection buys a retry or a
   *   clarification", which had no implementation behind it. Concretely: the
   *   model wrote `type` as `"design"` (the brief's own example uses `design`
   *   as a ref, and it copied that across), so **the most expensive call in the
   *   product** was thrown away, the user got back a generic template unrelated
   *   to their requirement, and the only account of what happened was one line
   *   of gray text.
   *
   *   Yet these failures are almost entirely **formatting** failures, not
   *   comprehension failures: hand zod's own sentences back and the model
   *   usually fixes them in one round. One repair round costs far less than
   *   discarding a complete requirement analysis.
   *
   * ★★ `output_missing` is repairable too. A zero-exit runtime proves that the
   *   model was reachable; a second brief can name the exact protocol failure
   *   and require a real file-tool call. Runtime refusal and timeout still stop
   *   immediately because another prompt cannot change either condition.
   *
   * ★ Same agent, no substitution. Switching agents means this round cannot see
   *   the previous round's artifact (the workspace is mounted against that
   *   agent's grants), and the entire value of a repair round is "revise the
   *   previous version".
   *
   * ★ Each round opens its own **separate** agent_runs row. Merged into one,
   *   "why did round one fail" is overwritten by round two's result — and that
   *   is the only place anyone can later notice "this agent keeps getting the
   *   enum wrong". Cost accumulates across rounds.
   *
   *   一次规划最多两轮。此前只有一轮，产物不合格就整场作废；而这类错误几乎
   *   全是格式或交付协议错误，把报错原话递回去通常一轮就改对了。无产物、
   *   产物不合法和计划不自洽都允许一轮纠正；运行时拒收与超时不重试。
   *   同一个 Agent、每轮一条独立的 Run 记录、成本按轮累加。
   */
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

    const model = `${agent.runtimeKind}:${agent.model ?? 'default'}`;
    let brief = input.brief;
    let spent: number | null = null;
    let repaired = false;

    for (let round = 1; ; round += 1) {
      const attempt = await this.runOnce({ ...input, scope: input.scope, agent, brief, round });
      spent = addCost(spent, attempt.costUsd);

      if (attempt.ok) return { ok: true, value: attempt.value, model, costUsd: spent };

      const canRepair = REPAIRABLE_CODES.has(attempt.code) && round < MAX_PLANNING_ROUNDS;
      if (!canRepair) {
        /**
         * ★ "Still invalid after a retry" has to make it into the reason. This
         *   string is displayed all the way through to the requirement page and
         *   the plan page, and "we tried once and could not save it" versus "we
         *   never tried" are two different conclusions for the user: the first
         *   says go look at that agent's model choice, the second says go look
         *   at the platform.
         *
         *   「试过一次没救回来」和「一次都没试」对用户是两个不同的结论。
         */
        return fail(attempt.code, repaired ? `${attempt.reason}（重试过仍不合格）` : attempt.reason);
      }

      repaired = true;
      brief = buildRepairBrief(input.brief, attempt.reason, attempt.raw, attempt.stdout);
      this.diag(
        `[planning] ${input.kind} 第 ${round} 轮产出不合格，带着报错再试一轮：${attempt.reason}`,
      );
    }
  }

  /**
   * One round: open the run → mount the workspace → dispatch → collect the
   * artifact → validate. On failure the raw artifact is carried back so the
   * repair round has something to revise.
   */
  private async runOnce<T>(input: {
    scope: PlanningScope;
    kind: 'structure' | 'plan';
    brief: string;
    schema: { parse: (v: unknown) => T };
    check?: (value: T) => string[];
    agent: typeof agents.$inferSelect;
    round: number;
  }): Promise<Round<T>> {
    const agent = input.agent;
    const runId = randomUUID();
    const dir = join(this.root(), 'planning', runId);

    /**
     * ★★ Planning is a real agent execution too, so it has to leave a trace.
     *
     *   Before this it lived only in memory: absent from the run detail page and
     *   the agent view, its cost missing from the agent_runs totals, and nothing
     *   to look up afterward when something went wrong. Which is to say the most
     *   expensive call in the product, the one every later artifact is built on,
     *   was the only call with no record.
     *
     *   It is now a row with kind='planning' and a null work_item_id — no work
     *   item exists at this point, which is exactly why that column was widened.
     *
     *   规划也是一次真的 Agent 执行，必须留痕：此前它只活在内存里，
     *   产品里最贵的那次调用是唯一一次没有记录的调用。
     */
    await this.openRun(runId, agent, input.scope, input.kind, input.scope.requirementId ?? null);

    /**
     * Every failure path has to land on that row, or it sits in `dispatching`
     * forever.
     *
     * ★ Carry `raw`: whatever this round wrote is the only draft the repair
     *   round has to revise. Drop it and the next round rewrites from scratch —
     *   and very likely repeats the same mistake.
     * ★ Carry `costUsd` too: the discarded round **still spent money**, and
     *   leaving it out makes the cost on the plan page one round short.
     *
     *   每条失败路径都要落到那一行上，否则它会永远停在 dispatching；
     *   `raw` 是修正轮唯一的底稿，废掉的那一轮照样花了钱。
     */
    const failRun = async (
      code: PlanFallbackCode,
      reason: string,
      extra: { costUsd?: number | null; raw?: string | null; stdout?: string | null } = {},
    ): Promise<Round<T>> => {
      if (REPAIRABLE_CODES.has(code)) {
        await this.recordDeliveryValidation(
          runId,
          'failed',
          reason,
          extra.raw === undefined || extra.raw === null ? 0 : 1,
        );
      }
      await this.closeRun(
        runId,
        'failed',
        extra.costUsd ?? 0,
        reason,
        planningErrorClass(code),
      );
      return {
        ok: false,
        code,
        reason,
        costUsd: extra.costUsd ?? null,
        raw: extra.raw ?? null,
        stdout: extra.stdout ?? null,
      };
    };

    let acquired: Awaited<ReturnType<WorkspaceService['acquireLocal']>> | null = null;

    try {
      /**
       * ★ Go through the shared workspace channel instead of mkdir-ing a
       *   directory and hand-rolling a workspace object.
       *
       *   What this used to build was { repoRef:'planning', branch:'planning' }
       *   — a fake Git workspace, so the prompt told the agent "you are working
       *   on branch planning, which is based on planning". It is now an honest
       *   empty-directory workspace with a null vcs, and the prompt says
       *   something else entirely.
       *
       * ★ BRIEF.md is written through `seed` — it has to count toward the
       *   **baseline**. Written after acquire, the platform's own input file
       *   turns up under `added` in the change set and gets counted as the
       *   agent's output.
       *
       *   走统一的工作区通道，而不是自己捏一个假的 Git 工作区；BRIEF.md 必须
       *   经 seed 写入才算进基线，否则平台自己的输入文件会被当成 Agent 的产出。
       */
      /**
       * ★★ A planning run's permissions are evaluated **per project**, through
       *   the same function execution runs go through.
       *
       *   This used to read the org-level resourceScopes / allowedTools straight
       *   off the agents row. Two dispatch paths reading two different sources
       *   means "which repositories may this agent read" can have two answers
       *   depending on which path dispatched it — and planning is precisely the
       *   most expensive call, the one every later artifact is built on.
       *
       *   规划 Run 的权限同样按项目求值，与执行 Run 走同一个求值器 ——
       *   各读各的会让「这个 Agent 能读哪些仓库」出现两个答案。
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
         * ★ Land the brief as a file rather than stuffing it into the prompt.
         *   Reading and writing files is what these CLIs are good at — a
         *   BRIEF.md they can re-read as often as they like fits how they work
         *   far better than a few thousand words in a one-shot prompt, and it
         *   leaves this planning attempt reviewable afterward (the directory is
         *   kept, not deleted).
         *
         *   把任务书落成文件而不是只塞进 prompt，既贴合 CLI 的工作方式，
         *   也让这次规划事后可复查。
         */
        seed: async (path) => {
          await writeFile(join(path, 'BRIEF.md'), input.brief, 'utf8');
        },
        /**
         * ★★ Mount the project resources this agent is granted, **read-only**.
         *
         *   Before this, a planning run got a bare empty directory: write one
         *   BRIEF.md in, read one apos-output.json out. Which meant that while
         *   "analyzing this project's requirement" the agent held none of the
         *   project's code — it could only invent from the requirement text,
         *   while the artifact claimed to be "based on project context".
         *
         * ★ Read-only: planning has no business changing code. Output still goes
         *   to the writable main mount, keeping the two apart. A resource that
         *   fails to mount does not sink the whole planning attempt, but it does
         *   leave a trace in the diagnostics (see acquireLocal).
         *
         *   只读挂载被授权的项目资源：规划不该改代码，而没有代码的规划
         *   只能照着需求原文编。挂不上的资源不拖垮整次规划，但会留痕。
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
      if (raw === null) {
        return failRun('output_missing', `Agent 结束了但没有写出 ${OUTPUT_FILE}`, {
          costUsd: outcome.costUsd,
          stdout: outcome.stdout,
        });
      }

      let parsed: T;
      try {
        parsed = input.schema.parse(JSON.parse(stripFence(raw)));
      } catch (err) {
        return failRun('output_invalid', `${OUTPUT_FILE} 不符合约定格式：${describe(err)}`, {
          costUsd: outcome.costUsd,
          raw,
          stdout: outcome.stdout,
        });
      }

      const problems = input.check?.(parsed) ?? [];
      if (problems.length > 0) {
        return failRun('output_inconsistent', `产出的计划不自洽：${problems.join('；')}`, {
          costUsd: outcome.costUsd,
          raw,
          stdout: outcome.stdout,
        });
      }

      this.diag(
        `[planning] ${input.kind} 由 ${agent.name} 完成（第 ${input.round} 轮），工作区 ${dir}`,
      );
      await this.recordDeliveryValidation(runId, 'passed', `${OUTPUT_FILE} 已写入并通过 schema 校验`, 1);
      await this.closeRun(runId, 'completed', outcome.costUsd, null, null);
      return { ok: true, value: parsed, costUsd: outcome.costUsd };
    } catch (err) {
      return failRun('unexpected_error', describe(err));
    } finally {
      /**
       * ★ keep: true — the directory stays for people to inspect afterward
       *   (existing behavior: when planning fails, BRIEF.md and whatever the
       *   agent half-wrote are the only troubleshooting material there is).
       *   What the teardown does is clear the baseline snapshot and record the
       *   change set in the diagnostics, not delete the directory.
       *
       *   规划失败时 BRIEF.md 与半成品是唯一的排查材料，所以目录留着不删。
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
   * Whether this agent can take planning work right now; null when it can,
   * otherwise **a reason that can be read out to the user as-is**.
   *
   * ★ Factored out because the explicitly named agent and the bound ones must
   *   be judged by the **same** criteria. Written twice, the two drift, and
   *   sooner or later the bound path blocks something the named path lets
   *   through — and the named path is exactly the one the user's own input
   *   drives.
   *
   *   点名的那个与绑定的那些必须走同一套判据，否则迟早出现
   *   「绑定路径拦得住、点名路径拦不住」。
   */
  private unusableReason(agent: typeof agents.$inferSelect): string | null {
    if (agent.status !== 'active') return agent.status;
    /**
     * ★ applicableTypes is deliberately **no longer** a gate here. The reason is
     *   on PLANNING_TYPE: it decides work-item dispatch, not PRD authorship.
     *   Left in, it would veto at analysis time the very pick the requirement
     *   page had just accepted — moving validation from "when you choose" to
     *   "when you are waiting for the result", which is the worst behavior this
     *   feature could have.
     *
     *   这里不再卡 applicableTypes：它是派工作项的判据，留在这里等于把校验
     *   从「选的时候」推迟到「等结果的时候」。
     */
    if (!this.registry.has(agent.id)) return '运行时未注册';
    return null;
  }

  /**
   * Pick the planning agent — the project's **explicit binding** first.
   *
   * ★★ Before project_agent_bindings existed, this was "the first agent in the
   *   org with status=active whose applicableTypes contains requirement",
   *   ordered by createdAt. Three consequences: the user could not name one;
   *   changing it meant editing some other agent's configuration or the order
   *   accounts were created in; and it **ignored project membership entirely**
   *   — any agent in the org could be pulled in to read this project's
   *   requirement, when the project is precisely the boundary for permissions
   *   and context.
   *
   * ★★ The candidates are **the project's agent members**, all of them, not
   *   filtered by applicable type. Authoring a PRD is not work-item dispatch,
   *   so applicableTypes only orders this path (see PLANNING_TYPE). The
   *   authorization boundary is still membership, undiminished.
   *
   * ★ Bindings win; only without one do we fall back to the old "auto-pick
   *   within the org", and **the fallback says so** (the reason travels all the
   *   way into the model field — see the discipline in the class doc). Erroring
   *   outright instead would fail the next analysis in every existing project
   *   that has not gotten around to configuring a binding.
   *
   * ★ Whatever the fallback picks must also be a member of this project — this
   *   rule outranks bindings: it is authorization, not preference.
   *
   *   先看项目显式绑定的那个；候选是项目的 Agent 成员全体，适用类型只排先后。
   *   没绑定时回退到组织内自动挑，但必须说出来 —— 直接报错会让所有还没配
   *   绑定的既有项目在下一次分析时全部失败。回退挑出来的也必须是本项目成员：
   *   那是授权，不是偏好。
   */
  private async pickAgent(
    scope: PlanningScope,
  ): Promise<{ agent: typeof agents.$inferSelect | null; reason: string }> {
    /**
     * ★★ The user named an agent on the requirement page — this beats the
     *   project binding, and there is **no substitute**.
     *
     *   Falling back to someone else is the one thing this path must never do:
     *   on the binding path a fallback reads as "the system covered for you",
     *   while on the named path it reads as "the system overruled your choice
     *   and did not mention it". So when the named agent is unusable we return
     *   null plus a reason, let this analysis fall back honestly to the
     *   rule-based placeholder, and write the reason all the way into
     *   analysisModel, where the requirement page shows it next to the result
     *   heading.
     *
     * ★ The authorization check is undiminished and comes **before** usability:
     *   an agent that is not a member of this project should not even be
     *   discussed in terms of "unavailable" — the project is the boundary for
     *   permissions and context, and this id arrived straight from an HTTP
     *   request.
     *
     *   点名压过项目绑定，而且没有备选：静默换人比如实失败更糟。
     *   授权检查排在可用性之前 —— 这个 id 是从 HTTP 请求一路传下来的。
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
     * ★★ Walk down the priority order rather than looking only at the primary
     *   agent.
     *
     *   With only a primary, pausing it breaks planning for the entire project,
     *   and the sole remedy is an admin editing the binding — which typically
     *   happens while somebody is waiting for a result. Backups let it step down
     *   one slot and keep going, while saying out loud why the primary was not
     *   used.
     *
     *   按 priority 顺着往下退：只有主 Agent 时，它一停用整个项目的规划就断了。
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
         * ★ Say so when stepping down to a backup. Silently, the user gets an
         *   artifact from an agent they never chose while the UI looks entirely
         *   normal — planning quality changes overnight with nothing to explain
         *   it.
         *
         *   退到备选时要说出来，否则规划质量突然变了却查不到原因。
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
     * ★★ "applicableTypes contains requirement" is a **sort preference** here,
     *   not a filter.
     *
     *   It used to be a SQL where clause: a project could have five agent
     *   members, and if none of them had ticked requirement the auto-pick
     *   returned nothing and the analysis dropped to the rule-based placeholder
     *   — while any one of those five could have authored the PRD. Now the ones
     *   that ticked it sort first and the ones that did not are still eligible.
     *
     * ★ Layer by "usable right now" first, then apply the preference. The other
     *   way around picks an agent that declared requirement but has no
     *   registered runtime while a runnable one stands right beside it. When
     *   none is usable, fall back to the full list so run() can report the
     *   specific reason instead of a vague "no agent available".
     *
     *   适用类型是排序偏好不是过滤条件；先按「现在可用」分层再按偏好挑，
     *   一个都不可用时退回整份名单，好让 run() 报出具体原因。
     */
    const usable = candidates.filter((a) => this.unusableReason(a) === null);
    const pool = usable.length > 0 ? usable : candidates;
    const row = pool.find((a) => a.applicableTypes.includes(PLANNING_TYPE)) ?? pool[0]!;

    return { agent: row, reason: '' };
  }

  /**
   * Open a planning run row.
   *
   * ★ **The same table** as execution runs, told apart by `kind` — rather than
   *   a second planning_runs table. "What has this agent been doing lately" on
   *   the agent view has to show both kinds, and two tables would mean a union
   *   at every consumer.
   *
   * ★ idempotencyKey is the runId: planning is not hit twice by network retries
   *   the way dispatch is (the caller is an in-process await), but the column is
   *   NOT NULL and unique, and a naturally unique value is more honest than a
   *   blank one.
   *
   *   与执行 Run 共用一张表，靠 kind 区分；idempotencyKey 用 runId ——
   *   这一列 NOT NULL 且唯一，给个天然唯一的值比留空更诚实。
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
      // ★ No work item exists yet — exactly why work_item_id was widened to nullable
      workItemId: null,
      kind: 'planning',
      // ★ Without this the run is findable but not reachable — no entry point on the requirement page leads to it
      requirementId,
      agentId: agent.id,
      status: 'dispatching',
      idempotencyKey: runId,
      /**
       * ★★ A planning run's goal stores a **code**, not a Chinese sentence.
       *
       *   This line surfaces in the English UI ("Analysis runs" on the
       *   requirement page), where a Chinese sentence is just an unreadable
       *   blob. A planning run's goal has exactly two possible values, which
       *   makes it the textbook case for a code: a sentence serves only the
       *   Chinese UI, a code serves both languages.
       *
       * ★ Why `goal` rather than a new column: the column already means "what
       *   is this run trying to do". Execution runs put the work item title
       *   there (user content) and planning runs put the platform's own code —
       *   the UI tells them apart by `kind`, so the two never collide.
       *
       *   ★★ It especially must not go into `inputContext`: that column is an
       *   **array** (TaskDispatch['context'], each entry carrying
       *   kind/ref/title/priority) and the run detail page calls `.length` and
       *   `.map()` on it. Put an object in there and the detail page of every
       *   planning run crashes on sight.
       *
       *   规划 Run 的 goal 存码不存中文句子 —— 这一行会出现在英文界面上。
       *   放 `goal` 而不是另起一栏，是因为这一栏本来就是「这次 Run 要干什么」；
       *   绝不能放进 `inputContext`，那一栏是数组，塞对象进去详情页当场崩。
       */
      goal: kind === 'structure' ? 'structure' : 'plan',
      model: agent.model,
      startedAt: new Date(),
    });
  }

  /** Close out that row. On failure the reason goes into errorSummary so it can be looked up later. */
  private async closeRun(
    runId: string,
    status: 'completed' | 'failed',
    costUsd: number | null,
    reason: string | null,
    errorClass: ErrorClass | null,
  ): Promise<void> {
    await this.db
      .update(agentRuns)
      .set({
        status,
        /**
         * ★ agent_runs.cost is a NOT NULL "for reference" column, so 0 is all
         *   that can land here. The "not reported" fact is carried by the layer
         *   above instead (plans.generation_cost is nullable) and that is the
         *   column the UI reads. Telling the two apart on the run detail page
         *   too would need a migration on this column first.
         *
         *   这一列 NOT NULL，落不下「没上报」；那条信息由 plans.generation_cost 带走。
         */
        cost: String(costUsd ?? 0),
        endedAt: new Date(),
        ...(reason === null ? {} : { errorMessage: reason, errorClass }),
      })
      .where(eq(agentRuns.id, runId));
  }

  private buildDispatch(
    runId: string,
    agent: typeof agents.$inferSelect,
    workspace: RunWorkspace,
    brief: string,
    access: EffectiveAgentAccess,
  ): TaskDispatch {
    /** ★ What goes out is the evaluated result, not the legacy org-level fields on the agent row. */
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
       * ★ An empty-directory workspace, not a git worktree.
       *   Planning needs no repository: it reads the requirement text and writes
       *   one JSON file. Actually cloning a repo would only add tens of seconds
       *   of waiting to every planning attempt.
       *
       *   规划不需要仓库，clone 一次只会让它多等几十秒。
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
       * ★ Planning runs have no policy gates; the empty array is a conclusion,
       *   not an oversight. Policy is evaluated on work item transitions, and
       *   planning runs **before** any work item exists — there is nothing to
       *   transition. Planning output is gated on another path entirely: plan
       *   approval (`plan.approved`). Inventing a warning here would only send
       *   the agent guarding against a gate it will never meet.
       *
       *   空数组是结论不是遗漏：Policy 挂在工作项的状态流转上，而规划跑在
       *   建出工作项之前；规划产出的把关走计划审批那条路。
       */
      policyGates: [],
      limits: {
        maxTokens: agent.tokenLimitPerRun,
        maxCostUsd: usdCeilingForTokens(agent.model, agent.tokenLimitPerRun),
        maxDurationSeconds: agent.timeoutSeconds,
      },
      model: agent.model,
      /**
       * ★ The callback URL is for execution runs — a planning run is not what
       *   that endpoint looks up, so it would not find this one. Events are
       *   collected here through subscribe instead, and an obviously invalid
       *   address is clearer than a real one that 404s.
       *
       *   规划 Run 靠 subscribe 直接收事件，给个明确无效的地址比给一个会 404 的更清楚。
       */
      /** ★ The planning language is pinned by the brief itself (languageRule); a default suffices here. */
      outputLocale: 'en',
      callback: { eventsUrl: 'inline://planning', token: runId },
    };
  }

  /**
   * Subscribe until run_ended, accumulating cost along the way. The timeout is
   * handled here — there is no supervisor for planning runs.
   */
  private async awaitRun(
    adapter: ReturnType<RuntimeRegistry['get']>,
    runId: string,
    agentTimeoutSeconds: number,
  ): Promise<
    | { ok: true; costUsd: number | null; stdout: string | null }
    | { ok: false; reason: string }
  > {
    const budgetMs = Math.min(
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      agentTimeoutSeconds * 1000,
    );

    /**
     * ★★ null = this runtime **never once reported** cost, not "it cost $0".
     *
     *   This used to be `let costUsd = 0`, and runtimes like opencode emit no
     *   cost event at all — so a real 38-second planning run was stored as
     *   0.0000 and the plan page said $0.00. "Not reported" and "free" became
     *   indistinguishable in the data, while every layer downstream is entitled
     *   to believe that zero (issue log: NEW-BUG-2). The tokens side has used
     *   this convention all along.
     *
     *   null 表示运行时一次都没上报成本，不是花了 0 块 —— 两者混起来的话，
     *   一次真实的规划会在计划页上显示 $0.00。
     */
    let costUsd: number | null = null;
    const stdoutTail: string[] = [];
    let settle: (
      r: { ok: true; costUsd: number | null; stdout: string | null } | { ok: false; reason: string },
    ) => void;
    const done = new Promise<
      { ok: true; costUsd: number | null; stdout: string | null } | { ok: false; reason: string }
    >((r) => (settle = r));

    /**
     * Some CLI translators carry token usage in a protocol `cost` event with
     * zero-valued money fields because the protocol has no token-only event.
     * The runtime manifest tells us whether those money fields are authoritative;
     * without this gate, enabling OpenCode's JSON stream turns an unknown cost
     * back into a misleading "$0.00" on the plan page.
     *
     * 有些 CLI 为了上报 token 会发金额为 0 的 cost 事件；只有运行时声明能上报
     * 成本时才把它当金额，否则 OpenCode 一开 JSON 流，未知成本又会显示成 $0.00。
     */
    const reportsCost = await adapter
      .getCapabilities()
      .then((c) => c.features.costReporting)
      .catch(() => false);

    const unsubscribe = await adapter.subscribe(runId, async (e: RunEvent) => {
      /**
       * ★★ Events have to be persisted, not merely passed through memory.
       *
       *   A planning run is now a real agent_runs row, and the run detail page
       *   renders its timeline and cost breakdown from run_events. Without
       *   persisting, that page is empty for planning runs — "what did this
       *   analysis actually do" still cannot be answered, and auditability is
       *   only half built.
       *
       * ★ A failed insert does not affect this planning attempt: progress is
       *   supplementary, and aborting an analysis that is already running for
       *   its sake is a bad trade.
       *
       *   事件要落库，否则 Run 详情页对规划 Run 是空的；落库失败则不影响
       *   这次规划本身。
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
          tokensDelta: e.type === 'cost' ? totalTokens(e.tokens) : null,
          costDelta: e.type === 'cost' ? String(e.deltaUsd) : null,
        })
        .onConflictDoNothing()
        .catch(() => undefined);

      // ★ Keep the heartbeat moving so the run detail page can show it is still alive
      await this.db
        .update(agentRuns)
        .set({
          lastHeartbeatAt: new Date(),
          ...(e.type === 'cost'
            ? {
                cost: String(e.totalUsd),
                tokensInput: sql`${agentRuns.tokensInput} + ${e.tokens.input}`,
                tokensOutput: sql`${agentRuns.tokensOutput} + ${e.tokens.output}`,
                tokensCacheRead: sql`${agentRuns.tokensCacheRead} + ${e.tokens.cacheRead}`,
                tokensCacheWrite: sql`${agentRuns.tokensCacheWrite} + ${e.tokens.cacheWrite}`,
              }
            : {}),
        })
        .where(eq(agentRuns.id, runId))
        .catch(() => undefined);

      if (e.type === 'cost' && reportsCost) costUsd = e.totalUsd;
      if (e.type === 'note') {
        stdoutTail.push(e.text);
        while (stdoutTail.join('\n').length > 8_000 && stdoutTail.length > 1) stdoutTail.shift();
      }
      if (e.type === 'error') this.diag(`[planning] ${runId} 报错`, e.error);
      if (e.type === 'run_ended') {
        settle(
          e.outcome === 'completed'
            ? { ok: true, costUsd, stdout: stdoutTail.length > 0 ? stdoutTail.join('\n') : null }
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
      // Unsubscribe may return synchronously, so it cannot be `.catch`ed directly
      await Promise.resolve(unsubscribe()).catch(() => {});
      /**
       * ★ Terminate explicitly after a timeout, or the CLI child process keeps
       *   running to its own ceiling — one timeout leaves behind an orphan
       *   process still burning money, with nowhere to see it.
       *
       *   不主动终止的话，一次超时会留下一个还在烧钱、又看不见的孤儿进程。
       */
      await adapter.control(runId, { action: 'terminate', reason: '规划超时' }).catch(() => {});
    }
  }

  /** Persist the platform verdict separately from the runtime process verdict. */
  private async recordDeliveryValidation(
    runId: string,
    status: 'passed' | 'failed',
    summary: string,
    artifacts: number,
  ): Promise<void> {
    const [last] = await this.db
      .select({ seq: runEvents.seq })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(desc(runEvents.seq))
      .limit(1);
    const event: RunEvent = {
      runId,
      seq: (last?.seq ?? -1) + 1,
      ts: new Date().toISOString(),
      type: 'delivery_validation',
      status,
      summary,
      changes: 0,
      artifacts,
    };
    await this.db
      .insert(runEvents)
      .values({
        runId,
        seq: event.seq,
        ts: new Date(event.ts),
        type: event.type,
        level: 'milestone',
        summary,
        payload: event as unknown as Record<string, unknown>,
      })
      .onConflictDoNothing();
  }

  private root(): string {
    return resolve(this.options.root ?? process.env['AGENT_WORKSPACE_ROOT'] ?? '/tmp/apos-workspaces');
  }

  private diag(message: string, detail?: unknown) {
    this.options.onDiagnostic?.(message, detail);
  }
}

type Attempt<T> =
  | { ok: true; value: T; model: string; costUsd: number | null }
  | { ok: false; reason: string; code: PlanFallbackCode };

/**
 * The result of one round. It carries two things {@link Attempt} does not, both
 * for the next round: `raw` (the previous artifact, which the repair round
 * revises) and `costUsd` (the discarded round still spent money).
 */
type Round<T> =
  | { ok: true; value: T; costUsd: number | null }
  | {
      ok: false;
      code: PlanFallbackCode;
      reason: string;
      costUsd: number | null;
      raw: string | null;
      stdout: string | null;
    };

/**
 * Accumulate cost across rounds.
 *
 * ★ `null` means "the runtime did not report", not zero — collapsing the two
 *   puts a confident `$0.00` on the plan page for any runtime that never
 *   reports. So as soon as one round reports a figure, the total is the sum of
 *   the rounds that did; only when no round reported at all is it null.
 *
 *   只要有任何一轮报了数，总数就是那几轮的和；一轮都没报才是 null。
 */
function addCost(total: number | null, round: number | null): number | null {
  if (round === null) return total;
  return (total ?? 0) + round;
}

/**
 * ★ Every failure path has to carry a code.
 *
 *   The code drives what the UI does — suppress the automation promise, offer
 *   the right repair entry point — while the reason is only the detail line for
 *   logs and troubleshooting. Omitting the code leaves the UI with nothing but
 *   the "no idea why, just don't trust it" tier.
 *
 *   码决定界面怎么做，reason 只是给日志和排查看的那句细节。
 */
function fail(code: PlanFallbackCode, reason: string): { ok: false; reason: string; code: PlanFallbackCode } {
  return { ok: false, reason, code };
}

/**
 * Encode the reason into the model field when falling back.
 *
 * ★ This string is displayed all the way through to the plan page and the
 *   requirement page. It is the only channel by which the user learns that no
 *   real agent produced this — so it says so plainly, even at the cost of
 *   looking ugly.
 *
 *   这是用户唯一能知道「这次不是真 Agent 干的」的渠道，宁可难看也要说清楚。
 */
function degraded(baseModel: string, reason: string): string {
  return `${baseModel}（规则占位，未走 Agent：${reason}）`;
}

/** LLMs like to wrap JSON in a ```json fence. Cheaper to peel one layer off here than to break the habit. */
function stripFence(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return (fenced?.[1] ?? raw).trim();
}

/**
 * ★ A ZodError's message is one blob of JSON. This string is displayed all the
 *   way through to the requirement page, and throwing an issue array at the
 *   user says nothing at all — so it is compressed into short
 *   "field path: reason" sentences.
 *
 *   ZodError 的 message 是一整坨 JSON，压成「字段路径: 原因」的短句才有意义。
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
