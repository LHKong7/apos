import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { agents, type Database } from '@apos/db';
import type { RuntimeRegistry } from '@apos/agent-runtimes';
import type { AgentPermissions, RunEvent, TaskDispatch } from '@apos/contracts';
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
  onDiagnostic?: (message: string, detail?: unknown) => void;
}

/** 规划 Agent 的判据：能处理 `requirement` 类型的工作项 */
const PLANNING_TYPE = 'requirement';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * 用真实 Agent 运行时做需求结构化与计划生成。
 *
 * ★★ 与执行 Run 的关系：**刻意不共用 agent_runs**。
 *
 *   `agent_runs.work_item_id` 是 NOT NULL 且带外键，而规划发生在工作项
 *   存在之前 —— 想复用那套机械就得先把这个列改成可空，而它有 75 处消费点
 *   横跨 supervisor / recovery / review / graph / board / run-detail，
 *   每一处都假设「Run 属于某个工作项」。为了规划去松动那个不变量，
 *   换来的回归面比这个功能本身大得多。
 *
 *   所以规划 Run 是独立的：自己开工作区、自己收事件、自己管超时。
 *   代价写在这里，免得后来的人以为是漏了：
 *   - 不出现在 Run 详情页与 Agent 视图
 *   - supervisor / recovery 不管它，超时靠下面的 withTimeout
 *   - 成本不进 agent_runs 的统计（但进 plans.generationCost）
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

    const agent = await this.pickAgent(input.scope.orgId);
    if (!agent) {
      return fail(`组织内没有可用的规划 Agent（需要 applicableTypes 含 ${PLANNING_TYPE}）`);
    }
    if (!this.registry.has(agent.id)) {
      return fail(`Agent「${agent.name}」未在本进程注册（凭证缺失或运行时不可用）`);
    }

    const runId = randomUUID();
    const dir = join(this.root(), 'planning', runId);
    const model = `${agent.runtimeKind}:${agent.model ?? 'default'}`;

    try {
      await mkdir(dir, { recursive: true });
      /**
       * ★ 把任务书落成文件，而不是只塞进 prompt。
       *   这些 CLI 的强项就是读写文件 —— 给它一个能反复回看的 BRIEF.md，
       *   比把几千字塞进一次性的 prompt 更贴合它的工作方式，
       *   也让这次规划事后可复查（目录留着不删）。
       */
      await writeFile(join(dir, 'BRIEF.md'), input.brief, 'utf8');

      const adapter = this.registry.get(agent.id);
      const task = this.buildDispatch(runId, agent, dir, input.brief);

      const ack = await adapter.dispatch(task);
      if (!ack.accepted) return fail(`运行时拒绝任务：${ack.rejectReason ?? '未说明原因'}`);

      const outcome = await this.awaitRun(adapter, runId, agent.timeoutSeconds);
      if (!outcome.ok) return fail(outcome.reason);

      const raw = await readFile(join(dir, OUTPUT_FILE), 'utf8').catch(() => null);
      if (raw === null) return fail(`Agent 结束了但没有写出 ${OUTPUT_FILE}`);

      let parsed: T;
      try {
        parsed = input.schema.parse(JSON.parse(stripFence(raw)));
      } catch (err) {
        return fail(`${OUTPUT_FILE} 不符合约定格式：${describe(err)}`);
      }

      const problems = input.check?.(parsed) ?? [];
      if (problems.length > 0) return fail(`产出的计划不自洽：${problems.join('；')}`);

      this.diag(`[planning] ${input.kind} 由 ${agent.name} 完成，工作区 ${dir}`);
      return { ok: true, value: parsed, model, costUsd: outcome.costUsd };
    } catch (err) {
      return fail(describe(err));
    }
  }

  /**
   * 挑规划 Agent。
   *
   * ★ 复用 applicableTypes 而不是新加一个「是不是规划 Agent」的字段：
   *   `requirement` 本来就是工作项类型之一，界面上配 Agent 时勾它即可，
   *   不用为规划再发明一套配置概念。
   */
  private async pickAgent(orgId: string) {
    const [row] = await this.db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.orgId, orgId),
          eq(agents.status, 'active'),
          sql`${agents.applicableTypes} @> ARRAY[${PLANNING_TYPE}]::work_item_type[]`,
        ),
      )
      .orderBy(agents.createdAt)
      .limit(1);
    return row ?? null;
  }

  private buildDispatch(
    runId: string,
    agent: typeof agents.$inferSelect,
    dir: string,
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
       * ★ 这不是一个 git 工作树，是一个空目录。
       *   规划不需要仓库：它读的是需求原文，写的是一份 JSON。
       *   真去 clone 一个仓库只会让规划多等几十秒。
       */
      workspace: {
        path: dir,
        writable: true,
        additionalPaths: [],
        vcs: null,
      },
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
