import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import {
  decisions,
  events,
  policies,
  policyVersions,
  projects,
  users,
  workItems,
  type Database,
} from '@apos/db';
import { actionLabel } from '@apos/contracts';
import type { Action, AutonomyLevel, Condition, FactKey, Policy, PolicyContext } from '@apos/contracts';
import {
  ENV_LABELS,
  OPERATION_LABELS,
  auditPolicies,
  buildScenarios,
  compile,
  evaluate,
  explainPolicy,
  isAutoApprove,
  previewAutonomy,
  simulate,
  type HistoricalSample,
  type SimulationResult,
} from '@apos/domain';
import { fail, notFound } from './errors';

/**
 * Policy 配置（页面文档 13 §9）。
 *
 * ★ 这一页管的是「Agent 能自己做什么」。所有写操作都受两条硬约束：
 *   1. 项目规则只能收紧组织规则，永远不能放宽（产品文档 十·权限与安全）；
 *   2. Agent 不能修改 Policy —— 这些端点只认人类身份（登录签发的 JWT），
 *      Agent 回调用的是 run-scoped token，走不到这里。
 *      如果 Agent 能改自己的约束，整个治理体系就失效了。
 */

/**
 * 目前接入的数据源。
 *
 * ★ 硬编码不是偷懒 —— 它是一份「我们诚实地知道自己没有什么」的清单。
 *   CI 与安全扫描都还没接，条件里写了 testsResult 的规则永远匹配不上；
 *   体检会据此明确告诉用户「这条规则不会命中」，而不是让它安静地失效。
 */
const WIRED_FACTS: FactKey[] = ['agentReview'];

export async function getPolicies(db: Database, projectId: string) {
  const project = await loadProject(db, projectId);
  const rows = await loadProjectPolicies(db, project.orgId, projectId);
  const hits = await loadHits(db, projectId, rows);

  const audit = auditPolicies(rows, project.autonomyLevel as AutonomyLevel, hits, WIRED_FACTS);
  const hitMap = new Map(hits.map((h) => [h.policyId, h]));

  const serialize = (p: Policy) => ({
    ...p,
    /** 用模板拼接，不用大模型 —— 解释与实际执行逻辑必须严格一致（§5.6） */
    explanation: explainPolicy(p.condition, p.action),
    hits30d: hitMap.get(p.id)?.hits30d ?? 0,
    avgWaitSeconds: hitMap.get(p.id)?.avgWaitSeconds ?? null,
    /** 组织级规则在项目内只读（目前没有创建入口，将来有） */
    editable: p.projectId !== null,
  });

  return {
    project: { id: project.id, name: project.name, autonomyLevel: project.autonomyLevel },
    orgPolicies: rows.filter((p) => p.projectId === null).map(serialize),
    projectPolicies: rows.filter((p) => p.projectId !== null).map(serialize),
    summary: audit.summary,
    issues: audit.issues,
    /** 页面要如实说明哪些数据源没接 */
    wiredFacts: WIRED_FACTS,
  };
}

// ── 写操作 ────────────────────────────────────────────────────────────────

export interface PolicyDraft {
  name: string;
  description?: string;
  priority: number;
  condition: Condition;
  action: Action;
  enabled?: boolean;
}

/**
 * 保存规则（新建或修改）。
 *
 * ★ 这里与页面文档 §9 的接口设计有一处刻意的偏离：文档要求放宽类变更
 *   携带 `simulation_id`。但那个 id 是客户端给的 —— 伪造一个字符串就能绕过，
 *   而这道闸恰恰是本页最重要的安全阀（§10「放宽类规则变更 100% 经过模拟验证」）。
 *
 *   改成服务端在保存时**自己跑一遍模拟**：判定为放宽且模拟发现了与人类判断
 *   不一致的历史案例时，返回 422 并把这些案例带回去，
 *   客户端必须显式 `acknowledgeMismatches` 才能继续。
 *   这样「必须看过模拟结果」是结构上成立的，不依赖客户端诚实。
 */
export async function savePolicy(
  db: Database,
  projectId: string,
  draft: PolicyDraft,
  actorId: string,
  opts: {
    policyId?: string;
    acknowledgeMismatches?: boolean;
    /**
     * 权限判定回调（09-security §2.3 的不对称设计）。
     *
     * ★ 收紧与放宽是两档权限，而「这次改动算哪一档」要把新旧规则
     *   各跑一遍才知道 —— 路由层只能挡住连收紧都不够格的人。
     *   所以判定必须在这里、在方向算出来之后，用回调把结论问回去。
     */
    assertCan?: (permission: 'policy.tighten' | 'policy.loosen') => void;
  } = {},
) {
  const project = await loadProject(db, projectId);
  const existing = await loadProjectPolicies(db, project.orgId, projectId);

  if (opts.policyId) {
    const target = existing.find((p) => p.id === opts.policyId);
    if (!target) throw notFound('policy');
    assertEditable(target);
  }

  const candidate: Policy = {
    id: opts.policyId ?? randomUUID(),
    orgId: project.orgId,
    projectId,
    name: draft.name,
    description: draft.description ?? '',
    priority: draft.priority,
    enabled: draft.enabled ?? true,
    condition: draft.condition,
    action: draft.action,
  };

  const next = [...existing.filter((p) => p.id !== candidate.id), candidate];
  const level = project.autonomyLevel as AutonomyLevel;

  assertNotLooseningOrgRules(existing, next, level);

  const loosened = loosenedScenarios(existing, next, level);
  let simulation: SimulationResult | null = null;

  /**
   * ★★ 权限判定要在跑模拟**之前**。
   *
   *   模拟要扫 90 天的历史评估记录，是这条路径上最贵的一步。
   *   放在权限之后判，等于让一个没资格放宽规则的人也能把它跑一遍 ——
   *   既白烧数据库，又把「哪些历史任务会被自动放行」这份信息
   *   送给了不该看到它的人。判定顺序在这里不只是效率问题。
   *
   *   方向的判据与审计口径保持一致（见下方 direction 的说明）：
   *   一条会自动放行的规则，即使场景网格没变松，也按放宽处理。
   */
  if (opts.assertCan) {
    const willAutoApprove = isAutoApprove(candidate.action) && candidate.enabled;
    opts.assertCan(loosened > 0 || willAutoApprove ? 'policy.loosen' : 'policy.tighten');
  }

  /**
   * ★ 只要这条规则会自动放行，就跑一遍模拟 —— 判据不是「场景网格有没有变松」。
   *
   *   两者不等价，而且差别是会出事的那种：一条
   *   「中低风险部署自动放行」的规则，在网格上可能一个场景都没放宽
   *   （那些场景本来就被别的规则或默认策略放行了），
   *   但它照样会自动批准历史上 10 个被人驳回过的任务。
   *   按网格判，这条规则会一路绿灯保存下去，而这一页最重要的安全阀
   *   （§10「放宽类规则变更 100% 经过模拟验证」）就形同虚设。
   *
   *   代价是每次保存放行类规则都多一次历史查询。这个代价该付。
   */
  if (isAutoApprove(candidate.action) && candidate.enabled) {
    simulation = await runSimulation(db, projectId, candidate, '90d');
    if (simulation.mismatches.length > 0 && !opts.acknowledgeMismatches) {
      throw fail(
        'POLICY_DENIED',
        'policy.loosening_contradicts_history',
        `这条规则会自动放行 ${simulation.wouldAutoHandle} 次评估，` + `而其中 ${simulation.mismatches.length} 个任务，人类当时是驳回或要求修改的。请先看看这些案例。`,
        { params: { approvals: simulation.wouldAutoHandle, mismatches: simulation.mismatches.length }, details: { simulation, loosenedScenarios: loosened, requiresAcknowledgement: true } },
      );
    }
  }

  /**
   * ★ 审计里的方向要按「这条规则做什么」记，不能只按场景网格有没有变松。
   *   一条自动放行的规则在网格上可能一个场景都没放宽（那些场景本来就是自动的），
   *   记成「收紧」就是在审计记录里撒谎 —— 而审计恰恰是事后唯一能查的东西。
   */
  const direction = loosened > 0 || (isAutoApprove(candidate.action) && candidate.enabled)
    ? 'loosen'
    : 'tighten';
  const before = existing.find((p) => p.id === candidate.id) ?? null;

  await db.transaction(async (tx) => {
    if (opts.policyId) {
      await tx
        .update(policies)
        .set({
          name: candidate.name,
          description: candidate.description,
          priority: candidate.priority,
          enabled: candidate.enabled,
          condition: candidate.condition,
          action: candidate.action,
          version: sql`${policies.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(policies.id, candidate.id));
    } else {
      await tx.insert(policies).values({
        id: candidate.id,
        orgId: candidate.orgId,
        projectId,
        name: candidate.name,
        description: candidate.description,
        priority: candidate.priority,
        enabled: candidate.enabled,
        condition: candidate.condition,
        action: candidate.action,
        createdBy: actorId,
      });
    }

    // ★ Policy 变更是高敏感操作，必须完整审计（产品文档 10.5）
    const [row] = await tx.select().from(policies).where(eq(policies.id, candidate.id));
    await tx.insert(policyVersions).values({
      policyId: candidate.id,
      version: row?.version ?? 1,
      snapshot: { before, after: candidate },
      changedBy: actorId,
      direction,
    });
  });

  return { policy: candidate, direction, loosenedScenarios: loosened, simulation };
}

export async function togglePolicy(
  db: Database,
  projectId: string,
  policyId: string,
  enabled: boolean,
  reason: string,
  actorId: string,
) {
  const project = await loadProject(db, projectId);
  const existing = await loadProjectPolicies(db, project.orgId, projectId);
  const target = existing.find((p) => p.id === policyId);
  if (!target) throw notFound('policy');
  assertEditable(target);

  // 停用一条收紧类规则等于放宽，同样要过模拟这道闸
  const next = existing.map((p) => (p.id === policyId ? { ...p, enabled } : p));
  const level = project.autonomyLevel as AutonomyLevel;
  assertNotLooseningOrgRules(existing, next, level);

  await db.transaction(async (tx) => {
    await tx
      .update(policies)
      .set({
        enabled,
        disabledBy: enabled ? null : actorId,
        disabledReason: enabled ? null : reason,
        version: sql`${policies.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(policies.id, policyId));

    const [row] = await tx.select().from(policies).where(eq(policies.id, policyId));
    await tx.insert(policyVersions).values({
      policyId,
      version: row?.version ?? 1,
      snapshot: { before: target, after: { ...target, enabled }, reason },
      changedBy: actorId,
      direction: enabled ? 'tighten' : 'loosen',
    });
  });

  return { ok: true as const, enabled };
}

export async function getPolicyHistory(db: Database, policyId: string) {
  const rows = await db
    .select()
    .from(policyVersions)
    .where(eq(policyVersions.policyId, policyId))
    .orderBy(desc(policyVersions.version));

  return {
    history: rows.map((r) => ({
      version: r.version,
      direction: r.direction,
      changedBy: r.changedBy,
      changedAt: r.changedAt.toISOString(),
      snapshot: r.snapshot,
    })),
  };
}

// ── 模拟与场景测试 ────────────────────────────────────────────────────────

/**
 * 历史回放（§5.7 —— 本页最重要的功能）。
 *
 * 数据来源是 `policy.evaluated` 事件上的 `contextSnapshot`。
 * 这正是「每次策略评估都必须带 23 项事实快照」这条铁律存在的理由：
 * 缺了它，模拟功能就是无米之炊，用户也就永远不敢放开自动化。
 */
export async function runSimulation(
  db: Database,
  projectId: string,
  draft: Pick<Policy, 'condition' | 'action'>,
  range: '7d' | '30d' | '90d',
): Promise<SimulationResult> {
  const days = { '7d': 7, '30d': 30, '90d': 90 }[range];
  const since = new Date(Date.now() - days * 86_400_000);

  const rows = await db
    .select({
      id: events.id,
      subjectId: events.subjectId,
      contextSnapshot: events.contextSnapshot,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(
        eq(events.projectId, projectId),
        eq(events.type, 'policy.evaluated'),
        gte(events.occurredAt, since),
      ),
    )
    .orderBy(desc(events.id))
    .limit(500);

  const withContext = rows.filter((r) => r.contextSnapshot !== null);
  const itemIds = [...new Set(withContext.map((r) => r.subjectId))];
  if (itemIds.length === 0) return simulate(draft, []);

  const titles = new Map(
    (await db
      .select({ id: workItems.id, title: workItems.title })
      .from(workItems)
      .where(inArray(workItems.id, itemIds))).map((i) => [i.id, i.title]),
  );

  // 当时人类怎么判的 —— 同一个任务上最接近那次评估的已解决决策
  const decisionRows = await db
    .select()
    .from(decisions)
    .where(inArray(decisions.workItemId, itemIds));

  const samples: HistoricalSample[] = withContext.map((r) => {
    const at = r.occurredAt.getTime();
    const candidates = decisionRows
      .filter((d) => d.workItemId === r.subjectId && d.resolvedAt !== null)
      .sort((a, b) => Math.abs(a.createdAt.getTime() - at) - Math.abs(b.createdAt.getTime() - at));
    const decision = candidates[0];

    return {
      eventId: String(r.id),
      workItemId: r.subjectId,
      occurredAt: r.occurredAt.toISOString(),
      context: r.contextSnapshot as PolicyContext,
      humanDecision:
        decision && ['approved', 'rejected', 'revision_requested'].includes(decision.status)
          ? (decision.status as HistoricalSample['humanDecision'])
          : null,
      humanNote: decision?.resolutionNote ?? null,
      workItemTitle: titles.get(r.subjectId) ?? '（已删除的任务）',
    };
  });

  return simulate(draft, samples);
}

/**
 * 手动构造场景测试（§5.7）。
 *
 * ★ 返回完整的匹配过程，而不只是结论。
 *   「我明明配了自动批准，为什么还找我」是这一页最常被问的问题，
 *   答案永远是「被某条更高优先级的规则先拦下了」——
 *   把优先级链条画出来，用户自己就看懂了。
 */
export async function evaluateScenario(
  db: Database,
  projectId: string,
  overrides: Partial<PolicyContext>,
) {
  const project = await loadProject(db, projectId);
  const rows = await loadProjectPolicies(db, project.orgId, projectId);
  const base = buildScenarios(project.autonomyLevel as AutonomyLevel)[0]!.context;
  const ctx: PolicyContext = { ...base, ...overrides, autonomyLevel: project.autonomyLevel as AutonomyLevel };

  const compiled = compile(rows);
  const verdict = evaluate(ctx, compiled);
  const byId = new Map(rows.map((p) => [p.id, p]));

  // 命中之后的规则根本没被评估过，如实标出来
  const matchedIndex = verdict.trace.findIndex((t) => t.matched);
  const evaluatedIds = new Set(
    verdict.trace.slice(0, matchedIndex === -1 ? undefined : matchedIndex + 1).map((t) => t.policyId),
  );

  return {
    context: ctx,
    action: verdict.action,
    requiresHuman: verdict.requiresHuman,
    matchedPolicyId: verdict.matchedPolicyId,
    matchedPolicyName: verdict.matchedPolicyName,
    explanation: explainPolicy(
      { fact: 'operationType', op: 'eq', value: ctx.operationType },
      verdict.action,
    ),
    trace: compiled.map((rule) => {
      const entry = verdict.trace.find((t) => t.policyId === rule.id);
      return {
        policyId: rule.id,
        name: rule.name,
        priority: rule.priority,
        scope: byId.get(rule.id)?.projectId === null ? ('org' as const) : ('project' as const),
        state: !evaluatedIds.has(rule.id)
          ? ('not_evaluated' as const)
          : entry?.matched
            ? ('matched' as const)
            : ('missed' as const),
        failedAt: entry?.failedAt ?? null,
      };
    }),
  };
}

export async function autonomyPreview(db: Database, projectId: string, to: AutonomyLevel) {
  const project = await loadProject(db, projectId);
  const rows = await loadProjectPolicies(db, project.orgId, projectId);
  return previewAutonomy(rows, project.autonomyLevel as AutonomyLevel, to);
}

// ── 内部 ─────────────────────────────────────────────────────────────────

async function loadProject(db: Database, projectId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound('project');
  return project;
}

export async function loadProjectPolicies(
  db: Database,
  orgId: string,
  projectId: string,
): Promise<Policy[]> {
  const rows = await db
    .select()
    .from(policies)
    .where(
      and(
        eq(policies.orgId, orgId),
        sql`(${policies.projectId} IS NULL OR ${policies.projectId} = ${projectId})`,
      ),
    )
    .orderBy(policies.priority);

  return rows
    .map((r) => ({
      id: r.id,
      orgId: r.orgId,
      projectId: r.projectId,
      name: r.name,
      description: r.description,
      priority: r.priority,
      enabled: r.enabled,
      condition: r.condition,
      action: r.action,
    }))
    .sort((a, b) => a.priority - b.priority);
}

/**
 * 近 30 天命中次数 + 规则存在了多久。
 *
 * `policies.hitCount30d` 那一列没有任何地方在维护，读它只会得到 0。
 * 直接从事件流数出来的才是真的 —— 而且事件流本来就是唯一不会被覆盖的历史。
 */
async function loadHits(db: Database, projectId: string, all: Policy[]) {
  const now = Date.now();
  const since = new Date(now - 30 * 86_400_000);
  const rows = await db
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.projectId, projectId),
        eq(events.type, 'policy.evaluated'),
        gte(events.occurredAt, since),
      ),
    );

  const counts = new Map<string, number>();
  for (const r of rows) {
    const id = (r.payload as { matchedPolicyId?: string | null }).matchedPolicyId;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const created = new Map(
    (await db
      .select({ id: policies.id, createdAt: policies.createdAt })
      .from(policies)
      .where(inArray(policies.id, all.map((p) => p.id)))
    ).map((r) => [r.id, r.createdAt.getTime()]),
  );

  // 覆盖全部规则，不只是被命中过的 —— 零命中检测要的正是没出现在计数里的那些
  return all.map((p) => ({
    policyId: p.id,
    hits30d: counts.get(p.id) ?? 0,
    ageDays: (now - (created.get(p.id) ?? now)) / 86_400_000,
    avgWaitSeconds: null,
  }));
}

function assertEditable(policy: Policy): void {
  if (policy.projectId === null) {
    throw fail(
      'FORBIDDEN',
      'policy.org_scoped_readonly',
      `「${policy.name}」是组织级规则，项目内不可修改或删除。如需例外，请联系组织管理员申请。`,
      { params: { name: policy.name }, details: { policyId: policy.id, scope: 'org' } },
    );
  }
}

/**
 * ★ 只能收紧不能放宽，是整套治理体系的硬约束。
 *
 *   判据不是比较两条规则的动作严格程度 —— 那会漏掉「用一条更高优先级的
 *   宽松规则把组织规则挡在后面」这种绕法。这里比的是**结果**：
 *   逐个场景跑一遍，看有没有哪个原本被组织规则拦下的场景变成了自动放行。
 *   绕不过去，因为最终生效的就是这个结果。
 */
function assertNotLooseningOrgRules(before: Policy[], after: Policy[], level: AutonomyLevel): void {
  const orgOnly = compile(before.filter((p) => p.projectId === null));
  const nextAll = compile(after);

  for (const scenario of buildScenarios(level)) {
    const org = evaluate(scenario.context, orgOnly);
    // 组织规则没管这个场景，项目怎么配都行
    if (org.matchedPolicyId === null || isAutoApprove(org.action)) continue;

    const next = evaluate(scenario.context, nextAll);
    if (!isAutoApprove(next.action)) continue;

    /**
     * ★ 有名字和没名字是两条词条，不是一条带空槽的。
     *   `matchedPolicyName` 类型上可空（没有规则命中时为 null）。塞一个空串
     *   进去会得到「组织规则「」要求…」——  一句读起来像 bug 的话。
     *   两种语言里「某条组织规则」都不是在原句上挖个洞就能得到的，
     *   所以它必须是独立的一句。
     */
    throw org.matchedPolicyName
      ? fail(
          'POLICY_DENIED',
          'policy.org_rule_cannot_be_loosened',
          `组织规则「${org.matchedPolicyName}」要求这类操作必须人工确认，项目级规则不能放宽它。` +
            `冲突场景：${describe(scenario.context)}。如需例外，请联系组织管理员申请。`,
          {
            params: { name: org.matchedPolicyName },
            details: { orgPolicyId: org.matchedPolicyId, scenario: scenario.key },
          },
        )
      : fail(
          'POLICY_DENIED',
          'policy.org_rule_cannot_be_loosened_unnamed',
          `一条组织规则要求这类操作必须人工确认，项目级规则不能放宽它。` +
            `冲突场景：${describe(scenario.context)}。如需例外，请联系组织管理员申请。`,
          { details: { orgPolicyId: org.matchedPolicyId, scenario: scenario.key } },
        );
  }
}

/** 变更后有多少个场景从「需要人」变成了「自动」 */
function loosenedScenarios(before: Policy[], after: Policy[], level: AutonomyLevel): number {
  const b = compile(before);
  const a = compile(after);
  let count = 0;

  for (const scenario of buildScenarios(level)) {
    const wasAuto = isAutoApprove(evaluate(scenario.context, b).action);
    const nowAuto = isAutoApprove(evaluate(scenario.context, a).action);
    if (!wasAuto && nowAuto) count++;
  }
  return count;
}

/** 用中文标签，不用枚举原值 —— 这句话是给项目负责人看的，不是给工程师看的 */
function describe(ctx: PolicyContext): string {
  const risk: Record<string, string> = { low: '低', medium: '中', high: '高', critical: '极高' };
  return [
    OPERATION_LABELS[ctx.operationType] ?? ctx.operationType,
    `风险${risk[ctx.riskLevel] ?? ctx.riskLevel}`,
    ctx.environment ? (ENV_LABELS[ctx.environment] ?? ctx.environment) : '不涉及特定环境',
  ].join(' · ');
}

export async function deletePolicy(db: Database, projectId: string, policyId: string) {
  const project = await loadProject(db, projectId);
  const rows = await loadProjectPolicies(db, project.orgId, projectId);
  const target = rows.find((p) => p.id === policyId);
  if (!target) throw notFound('policy');
  assertEditable(target);

  // 删除等于放宽，同样要过组织规则那道闸
  assertNotLooseningOrgRules(
    rows,
    rows.filter((p) => p.id !== policyId),
    project.autonomyLevel as AutonomyLevel,
  );

  const pending = await db
    .select({ id: decisions.id, title: decisions.title })
    .from(decisions)
    .where(and(eq(decisions.triggeredByPolicy, policyId), eq(decisions.status, 'pending')));

  if (pending.length > 0) {
    throw fail(
      'POLICY_DENIED',
      'policy.has_pending_decisions',
      `还有 ${pending.length} 个由这条规则触发的决策没处理完，先处理完再删除。`,
      { params: { count: pending.length }, details: { pending } },
    );
  }

  await db.delete(policies).where(eq(policies.id, policyId));
  return { ok: true as const };
}

export { isNull };

/**
 * 一条规则的命中明细（页面文档 13）。
 *
 * ★ 「近 30 天命中 47 次」是个死数字。看不到是哪 47 次的规则，
 *   等于一条无法审计的规则 —— 而无法审计的规则没人敢改，
 *   最后要么一直留着（哪怕它已经错了），要么被整条删掉。
 *
 * ★ 这一页真正要回答的不是「命中了几次」，是**「拦对了没有」**：
 *   规则要求人确认、而人每次都批准 → 这条规则在浪费所有人的时间，可以放开；
 *   人经常驳回 → 它拦对了，别动。这个判断只有把每次命中的**后续结果**
 *   摆出来才做得了，所以决策结局是这一页的主列，不是附注。
 */
export async function getPolicyHits(db: Database, projectId: string, policyId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound('project');

  const all = await loadProjectPolicies(db, project.orgId, projectId);
  const policy = all.find((p) => p.id === policyId);
  if (!policy) throw notFound('policy');

  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.projectId, projectId),
        eq(events.type, 'policy.evaluated'),
        gte(events.occurredAt, since),
      ),
    )
    .orderBy(desc(events.occurredAt));

  const mine = rows.filter(
    (r) => (r.payload as { matchedPolicyId?: string | null }).matchedPolicyId === policyId,
  );

  const itemIds = [...new Set(mine.map((r) => r.subjectId))];
  const items =
    itemIds.length > 0
      ? await db.select().from(workItems).where(inArray(workItems.id, itemIds))
      : [];
  const itemById = new Map(items.map((i) => [i.id, i]));

  /**
   * 这条规则触发的决策及其结局。
   *
   * ★ 规则 id 现在一律是 UUID，`decisions.triggered_by_policy` 直接对得上。
   *   （硬编码基线用的是 `baseline-xxx` 这种可读 id，写不进外键列，
   *   曾经只能靠 work item 回连 —— 那条兜底随基线一起删掉了。）
   */
  const decisionRows = itemIds.length > 0
    ? await db.select().from(decisions).where(inArray(decisions.workItemId, itemIds))
    : [];
  const relevant = decisionRows.filter((d) => d.triggeredByPolicy === policyId);
  const decisionByItem = new Map<string, typeof relevant>();
  for (const d of relevant) {
    if (!d.workItemId) continue;
    const list = decisionByItem.get(d.workItemId) ?? [];
    list.push(d);
    decisionByItem.set(d.workItemId, list);
  }

  const userRows = await db.select({ id: users.id, name: users.name }).from(users);
  const userName = new Map(userRows.map((u) => [u.id, u.name]));

  const hits = mine.map((r) => {
    const payload = r.payload as { action?: { type?: string } };
    const snapshot = r.contextSnapshot as PolicyContext | null;
    const item = itemById.get(r.subjectId);
    // 同一任务多次命中时取时间上最接近的那个决策
    const candidates = decisionByItem.get(r.subjectId) ?? [];
    const decision = nearestDecision(candidates, r.occurredAt.getTime());

    return {
      eventId: String(r.id),
      at: r.occurredAt.toISOString(),
      action: payload.action?.type ?? 'unknown',
      actionLabel: actionLabel(payload.action?.type ?? '未知'),
      workItemId: r.subjectId,
      workItemTitle: item?.title ?? '（已删除）',
      /** 触发时的关键上下文 —— 不给这几项，用户看不出为什么这次会命中 */
      context: snapshot
        ? {
            operationType: snapshot.operationType,
            riskLevel: snapshot.riskLevel,
            environment: snapshot.environment,
          }
        : null,
      decision: decision
        ? {
            id: decision.id,
            status: decision.status,
            statusLabel: DECISION_STATUS_LABELS[decision.status] ?? decision.status,
            resolvedBy: decision.resolvedBy ? (userName.get(decision.resolvedBy) ?? '未知') : null,
            waitMinutes:
              decision.resolvedAt === null
                ? null
                : Math.round((decision.resolvedAt.getTime() - decision.createdAt.getTime()) / 60_000),
          }
        : null,
    };
  });

  /**
   * ★ 自动放行的那些任务，事后被人手动改过没有。
   *
   *   放行类规则不产生决策，用「批准率」判断它对不对是无从谈起的。
   *   它唯一能被证伪的地方是：它放过去的事，后来有没有被人纠正。
   *   有，就说明放得太松 —— 这是唯一一条能说明放行规则错了的证据。
   */
  const overrideRows = itemIds.length > 0
    ? await db
        .select({ subjectId: events.subjectId, payload: events.payload })
        .from(events)
        .where(
          and(
            eq(events.projectId, projectId),
            eq(events.type, 'work_item.status_changed'),
            inArray(events.subjectId, itemIds),
            gte(events.occurredAt, since),
          ),
        )
    : [];
  const overridden = new Set(
    overrideRows
      .filter((r) => (r.payload as { manual?: boolean }).manual === true)
      .map((r) => r.subjectId),
  );

  const resolved = hits.filter((h) => h.decision && h.decision.status !== 'pending');
  const approved = resolved.filter((h) => h.decision!.status === 'approved').length;
  const waits = resolved
    .map((h) => h.decision!.waitMinutes)
    .filter((w): w is number => w !== null);

  return {
    policy: {
      id: policy.id,
      name: policy.name,
      enabled: policy.enabled,
      editable: policy.projectId !== null,
    },
    stats: {
      hits: hits.length,
      /**
       * ★ 按**动作枚举**分组，不按中文标签分组。
       *   用标签当分组键有两处坏处：界面拿到的是中文（英文界面上照样是中文），
       *   而且标签改一个字，历史统计就会分裂成两组。
       */
      byAction: countBy(hits.map((h) => h.action)),
      decisionsCreated: hits.filter((h) => h.decision).length,
      resolved: resolved.length,
      approved,
      /** ★ 这一页的结论就靠它：全批 = 规则在浪费时间；常驳 = 拦对了 */
      approvalRate: resolved.length === 0 ? null : Math.round((approved / resolved.length) * 100) / 100,
      avgWaitMinutes:
        waits.length === 0 ? null : Math.round(waits.reduce((a, b) => a + b, 0) / waits.length),
    },
    /**
     * ★ 给结论，不只给数字。「23 次全批准了」和「23 次里驳了 9 次」
     *   指向完全相反的动作，让用户自己从百分比推一遍是多余的一步。
     */
    /** 放行的任务里事后被人工改过的数量 —— 放行类规则唯一的证伪证据 */
    overriddenAfterPass: hits.filter((h) => !h.decision && overridden.has(h.workItemId)).length,
    verdict: verdictOf({
      hits: hits.length,
      resolved: resolved.length,
      approved,
      gating: hits.filter((h) => h.decision).length,
      overriddenAfterPass: hits.filter((h) => !h.decision && overridden.has(h.workItemId)).length,
    }),
    hits: hits.slice(0, 100),
    truncated: hits.length > 100,
  };
}

const DECISION_STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  approved: '已批准',
  rejected: '已驳回',
  expired: '已超时',
};

function nearestDecision<T extends { createdAt: Date }>(list: T[], at: number): T | undefined {
  let best: T | undefined;
  let bestGap = Infinity;
  for (const d of list) {
    const gap = Math.abs(d.createdAt.getTime() - at);
    if (gap < bestGap) {
      bestGap = gap;
      best = d;
    }
  }
  // 相隔超过一小时的多半不是同一次判定引发的，宁可不认
  return bestGap <= 3600_000 ? best : undefined;
}

function countBy(values: string[]): { label: string; count: number }[] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

/** 命中样本太少时不下结论 —— 三次里三次都批，说明不了任何事 */
const MIN_SAMPLE = 5;

/**
 * ★ 拦人的规则和放行的规则要用完全不同的标准评价。
 *
 *   拦人的看批准率：全批 = 在问答案已知的问题；常驳 = 拦对了。
 *   放行的根本不产生决策，套「批准率」是无从谈起的 ——
 *   它唯一能被证伪的地方是：放过去的事后来有没有被人纠正。
 *   用同一套话术评价两类规则，说出来的必然有一半是废话。
 */
function verdictOf(input: {
  hits: number;
  resolved: number;
  approved: number;
  gating: number;
  overriddenAfterPass: number;
}): string {
  const { hits, resolved, approved, gating, overriddenAfterPass } = input;

  if (hits === 0) {
    return '近 30 天没有命中。规则可能写错了条件，或者它防的那类操作确实没发生过';
  }

  // 放行类：没有产生过任何决策
  if (gating === 0) {
    if (overriddenAfterPass === 0) {
      return `自动放行 ${hits} 次，放行的任务事后没有一次被人工纠正 —— 这条规则在按预期省掉人工确认`;
    }
    return `自动放行 ${hits} 次，其中 ${overriddenAfterPass} 个任务事后被人手动改过 —— 这条规则可能放得太松，值得看看那几次`;
  }

  if (resolved === 0) {
    return `命中 ${hits} 次并要求了人工确认，但还没有一次被处理完 —— 现在看不出它拦得对不对`;
  }
  if (resolved < MIN_SAMPLE) {
    return `只有 ${resolved} 条决策已处理，样本还不够判断这条规则拦得对不对`;
  }
  const rate = approved / resolved;
  if (rate === 1) {
    return `${resolved} 次人工确认全部批准 —— 这条规则每次都在问一个答案已知的问题，可以考虑放开或收窄条件`;
  }
  if (rate >= 0.9) {
    return `${resolved} 次里批准了 ${approved} 次（${Math.round(rate * 100)}%）—— 绝大多数是走流程，值得看看能不能收窄条件`;
  }
  return `${resolved} 次里驳回了 ${resolved - approved} 次 —— 这条规则确实拦下了不该做的事，别动它`;
}
