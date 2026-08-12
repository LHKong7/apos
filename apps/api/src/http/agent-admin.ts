import { and, count, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  agentPermissionChanges,
  agentRuns,
  agents,
  users,
  workItems,
  type Database,
} from '@apos/db';
import {
  ACTIVE_RUN_STATUSES,
  envOverridesOf,
  isKnownRuntimeKind,
  isSecretEnvKey,
  ResourceScope,
  RUNTIME_KIND_SPECS,
  runtimeKindSpec,
  validateRuntimeConfig,
  WorkItemType,
  type AgentPermissions,
} from '@apos/contracts';
import { agentPermissionChangeDirection } from '@apos/domain';
import { checkCompatibility, type RuntimeRegistry } from '@apos/agent-runtimes';
import { registerAgentNow, type AgentRow } from '../modules/agent/runtime-factory';
import {
  describeEnvOverrides,
  describeRef,
  encodeEnvOverrides,
  encodeSecret,
  hasMasterKey,
  hintOf,
  maskEnvOverrides,
  SecretConfigError,
} from '../modules/security/secrets';
import { ApiError, notFound } from './errors';

/**
 * Agent 档案 —— 建 N 个 Agent，每个自带 headless CLI 类型与它的个性化配置。
 *
 * ★ 没有单独的「运行时接入」层。一个 Agent 就是
 *   「一种 CLI + 一套它的参数 + 一份凭证 + 一组权限」，是完整可用的执行主体。
 *   这样加一个新 Agent 只需要填一张表，而不是先去别处建接入再回来挂。
 *
 * ★ 代价是同一把 key 会被多个 Agent 各引用一次。缓解办法写进了界面引导：
 *   用 `env:变量名` 形态时 N 个 Agent 指向同一个变量名，轮换仍只改一处；
 *   另外 `credentialUsage` 会把「这把凭证被谁在用」聚合出来。
 *
 * ★ 凭证从不出现在任何响应里，只回 hint。见 modules/security/secrets.ts。
 */

// ── 平台侧的配置目录 ──────────────────────────────────────────────────

/**
 * 每种 CLI 能配什么，由平台统一定义。前端按它动态渲染表单 ——
 * 加一种 CLI 只改 contracts 里那一个文件，界面自动长出对应字段。
 */
export function listRuntimeCatalog() {
  return {
    kinds: RUNTIME_KIND_SPECS,
    canStoreInlineCredential: hasMasterKey(),
    credentialHelp:
      '推荐填 `env:变量名`：凭证只留在进程环境、不进数据库，多个 Agent 共用同一变量名时轮换只需改一处。' +
      '直接粘贴 key 需要部署时配置 APOS_SECRET_KEY，密文进库、钥匙在库外。',
  };
}

// ── Agent CRUD ────────────────────────────────────────────────────────

export const AgentInput = z.object({
  name: z.string().min(1, 'Agent 名称不能为空').max(80),
  type: z.string().min(1),
  description: z.string().nullable().optional(),

  /** headless CLI 类型 */
  runtimeKind: z.string().min(1, '必须选择运行时类型'),
  /** 该 CLI 的个性化参数，按 RUNTIME_KIND_SPECS 校验 */
  runtimeConfig: z.record(z.unknown()).optional(),
  endpoint: z.string().url('接入地址必须是合法 URL').nullable().optional(),
  /** 明文凭证或 `env:变量名`。不传 = 不改动；null = 清除 */
  credential: z.string().nullable().optional(),

  model: z.string().nullable().optional(),
  skills: z.array(z.string()).default([]),
  applicableTypes: z.array(WorkItemType).default([]),

  allowedTools: z.array(z.string()).default([]),
  deniedTools: z.array(z.string()).default([]),
  resourceScopes: z.array(ResourceScope).default([]),

  maxConcurrency: z.number().int().positive().max(50).default(3),
  timeoutSeconds: z.number().int().positive().max(86_400).default(1800),
  costLimitPerRun: z.number().positive().nullable().optional(),
  costLimitDaily: z.number().positive().nullable().optional(),

  /** ★ 不可为空：出问题时的问责链条不能断 */
  ownerId: z.string().uuid('必须指定负责人'),
});
export type AgentInput = z.infer<typeof AgentInput>;

export async function createAgent(
  db: Database,
  registry: RuntimeRegistry,
  orgId: string,
  input: AgentInput,
  actorUserId: string,
) {
  const spec = assertKind(input.runtimeKind);
  await assertOwner(db, input.ownerId);
  assertPermissionsSane(input);

  const { config, dropped } = prepareConfig(input.runtimeKind, input.runtimeConfig, null);

  const credential = input.credential?.trim() || null;
  if (spec.credential && !credential && !credentialGivenInEnv(config)) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `${spec.label} 需要凭证（${spec.credential.label}）。可填 \`env:变量名\` 让凭证留在进程环境里，` +
        '或在运行时配置的环境变量表里直接给出对应的变量。',
    );
  }

  const [row] = await db
    .insert(agents)
    .values({
      orgId,
      name: input.name.trim(),
      type: input.type,
      description: input.description ?? null,

      runtimeKind: input.runtimeKind,
      runtimeConfig: config,
      endpoint: input.endpoint ?? null,
      ...credentialColumns(credential),

      model: input.model ?? null,
      skills: input.skills,
      applicableTypes: input.applicableTypes,
      allowedTools: input.allowedTools,
      deniedTools: input.deniedTools,
      resourceScopes: input.resourceScopes,
      maxConcurrency: input.maxConcurrency,
      timeoutSeconds: input.timeoutSeconds,
      costLimitPerRun: input.costLimitPerRun == null ? null : String(input.costLimitPerRun),
      costLimitDaily: input.costLimitDaily == null ? null : String(input.costLimitDaily),
      ownerId: input.ownerId,
      status: 'active',
    })
    .returning();

  // ★ 立刻注册，不等下一轮同步 —— 否则新建的 Agent 在 15 秒内是隐形的，
  //   用户会以为「建了但没用」，而界面只会说「适配器没有在当前进程注册」
  registerAgentNow(registry, row!);

  // 建档本身就是一次权限授予，同样要留痕
  await db.insert(agentPermissionChanges).values({
    agentId: row!.id,
    changedBy: actorUserId,
    direction: 'grant',
    before: { allowedTools: [], deniedTools: [], resourceScopes: [] },
    after: permissionsOf(row!),
    reason: '创建 Agent',
  });

  return { agent: await describeAgent(db, registry, row!), droppedConfigKeys: dropped };
}

export async function updateAgent(
  db: Database,
  registry: RuntimeRegistry,
  agentId: string,
  input: Partial<AgentInput> & { reason?: string },
  actorUserId: string,
  /**
   * 权限方向判定回调（09-security §2.3）。
   *
   * ★ 扩大要 tech_lead、收紧只要 owner —— 而方向要把新旧权限比过才知道，
   *   路由层只挡得住「连改档案都不够格」的人。同 savePolicy 的处理。
   */
  assertCan?: (permission: 'agent.permissions.expand' | 'agent.permissions.restrict') => void,
) {
  const [existing] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!existing) throw notFound('Agent');

  const kind = input.runtimeKind ?? existing.runtimeKind;
  if (input.runtimeKind) assertKind(input.runtimeKind);
  if (input.ownerId) await assertOwner(db, input.ownerId);

  const merged = {
    allowedTools: input.allowedTools ?? existing.allowedTools,
    deniedTools: input.deniedTools ?? existing.deniedTools,
    resourceScopes: input.resourceScopes ?? existing.resourceScopes,
  };
  assertPermissionsSane(merged);

  const before = permissionsOf(existing);
  const permissionsChanged = JSON.stringify(before) !== JSON.stringify(merged);

  /**
   * ★ 放宽权限必须填原因。收紧不强制 ——
   *   收紧的默认解释（「收着点」）几乎总是对的，
   *   而放宽的默认解释（「大概是需要吧」）几乎总是不够。
   */
  const direction = permissionsChanged ? directionOf(before, merged) : null;
  if (direction && assertCan) {
    assertCan(
      direction === 'grant' ? 'agent.permissions.expand' : 'agent.permissions.restrict',
    );
  }
  if (direction === 'grant' && !input.reason?.trim()) {
    throw new ApiError('VALIDATION_FAILED', '放宽 Agent 权限必须填写原因');
  }

  /**
   * ★ 换了 CLI 类型就要重新校验配置：旧 kind 的参数在新 kind 下多半不合法，
   *   原样带过去的话，界面显示配置完好，实际派发时 CLI 收到一堆它不认识的参数。
   *
   * ★ 换类型时也不给 `prepareConfig` 传旧配置：配置整个重来了，
   *   此时出现的 `secret://saved` 占位符没有对应的旧值，应当当场报错，
   *   而不是从上一种 CLI 的环境变量表里捞一个同名的值接上。
   */
  const switchingKind = Boolean(input.runtimeKind && input.runtimeKind !== existing.runtimeKind);
  const prepared =
    input.runtimeConfig !== undefined || input.runtimeKind
      ? prepareConfig(
          kind,
          input.runtimeConfig ?? (input.runtimeKind ? {} : existing.runtimeConfig),
          switchingKind ? null : existing.runtimeConfig,
        )
      : null;

  const credential = input.credential === undefined ? undefined : input.credential?.trim() || null;

  const [row] = await db
    .update(agents)
    .set({
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      ...(input.runtimeKind ? { runtimeKind: input.runtimeKind } : {}),
      ...(prepared ? { runtimeConfig: prepared.config } : {}),
      ...(input.endpoint !== undefined ? { endpoint: input.endpoint ?? null } : {}),
      ...(credential !== undefined ? credentialColumns(credential) : {}),
      ...(input.model !== undefined ? { model: input.model ?? null } : {}),
      ...(input.skills ? { skills: input.skills } : {}),
      ...(input.applicableTypes ? { applicableTypes: input.applicableTypes } : {}),
      ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
      ...(input.deniedTools ? { deniedTools: input.deniedTools } : {}),
      ...(input.resourceScopes ? { resourceScopes: input.resourceScopes } : {}),
      ...(input.maxConcurrency ? { maxConcurrency: input.maxConcurrency } : {}),
      ...(input.timeoutSeconds ? { timeoutSeconds: input.timeoutSeconds } : {}),
      ...(input.costLimitPerRun !== undefined
        ? { costLimitPerRun: input.costLimitPerRun == null ? null : String(input.costLimitPerRun) }
        : {}),
      ...(input.costLimitDaily !== undefined
        ? { costLimitDaily: input.costLimitDaily == null ? null : String(input.costLimitDaily) }
        : {}),
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agentId))
    .returning();

  /**
   * ★ 必须**替换**注册表里的实例，不能跳过。
   *   老实例里还捏着旧的 effort、旧的凭证 —— 不换掉的话，
   *   界面上改完显示为已生效，而下一次派发仍然是旧值。
   */
  registerAgentNow(registry, row!);

  if (permissionsChanged) {
    await db.insert(agentPermissionChanges).values({
      agentId,
      changedBy: actorUserId,
      direction: direction ?? 'adjust',
      before,
      after: merged,
      reason: input.reason ?? null,
    });
  }

  return {
    agent: await describeAgent(db, registry, row!),
    permissionsChanged,
    droppedConfigKeys: prepared?.dropped ?? [],
  };
}

export async function deleteAgent(db: Database, agentId: string) {
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!row) throw notFound('Agent');

  const [active] = await db
    .select({ n: count() })
    .from(agentRuns)
    .where(and(eq(agentRuns.agentId, agentId), inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES])));

  if ((active?.n ?? 0) > 0) {
    throw new ApiError('VERSION_CONFLICT', `该 Agent 还有 ${active!.n} 个执行中的 Run，无法删除`, {
      activeRuns: active!.n,
    });
  }

  const [assigned] = await db
    .select({ n: count() })
    .from(workItems)
    .where(and(eq(workItems.executorType, 'agent'), eq(workItems.executorId, agentId)));

  /**
   * ★ 有历史执行记录的 Agent 只停用不删除。
   *   删掉的话，那些 Run 与产物的「谁做的」会指向一个不存在的 id ——
   *   审计链断在这里，而这正是最需要它的时候。
   */
  if ((assigned?.n ?? 0) > 0) {
    await db
      .update(agents)
      .set({ status: 'retired', pausedReason: '已停用（保留历史记录）', updatedAt: new Date() })
      .where(eq(agents.id, agentId));
    return { ok: true as const, retired: true, reason: '该 Agent 有历史执行记录，已停用而非删除' };
  }

  await db.delete(agentPermissionChanges).where(eq(agentPermissionChanges.agentId, agentId));
  await db.delete(agents).where(eq(agents.id, agentId));
  return { ok: true as const, retired: false, reason: null };
}

/**
 * 能力探测。
 *
 * ★ 「适配器没注册」「注册了但连不上」「连上了但缺能力」是三件不同的事，
 *   页面必须分别显示 —— 混成一句「不可用」，用户不知道该去装依赖、
 *   换 key，还是换个 Agent 跑高风险任务。
 */
export async function probeAgent(db: Database, registry: RuntimeRegistry, agentId: string) {
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!row) throw notFound('Agent');

  const described = await describeAgent(db, registry, row);

  await db
    .update(agents)
    .set({
      lastCheckAt: new Date(),
      ...(described.capability
        ? { capabilities: described.capability as unknown as Record<string, unknown> }
        : {}),
    })
    .where(eq(agents.id, agentId));

  return described;
}

export async function listAgentsAdmin(db: Database, registry: RuntimeRegistry, orgId: string) {
  const rows = await db.select().from(agents).where(eq(agents.orgId, orgId)).orderBy(agents.createdAt);

  return {
    agents: await Promise.all(rows.map((r) => describeAgent(db, registry, r))),
    /**
     * ★ 「这把凭证被谁在用」。取消接入层之后，这个问题失去了天然的答案位置 ——
     *   靠 credentialRef 聚合把它补回来，轮换前能一眼看到要动几个 Agent。
     */
    credentialUsage: usageByCredential(rows),
    ...listRuntimeCatalog(),
  };
}

/** 按凭证引用聚合。env: 形态的多个 Agent 会归到同一条，轮换只需改那个变量 */
function usageByCredential(rows: AgentRow[]) {
  const byRef = new Map<string, { hint: string | null; kind: string; agents: string[] }>();

  for (const a of rows) {
    if (!a.credentialRef) continue;
    const entry = byRef.get(a.credentialRef);
    if (entry) entry.agents.push(a.name);
    else
      byRef.set(a.credentialRef, {
        hint: a.credentialHint,
        kind: describeRef(a.credentialRef).kind,
        agents: [a.name],
      });
  }

  return [...byRef.values()].map((e) => ({
    ...e,
    /** env 形态轮换只需改环境变量；内联密文要逐个 Agent 重录 */
    rotationCost: e.kind === 'env' ? 'one_place' : `${e.agents.length}_places`,
  }));
}

async function describeAgent(db: Database, registry: RuntimeRegistry, row: AgentRow) {
  const cred = describeRef(row.credentialRef);
  const spec = runtimeKindSpec(row.runtimeKind);

  let capability: ReturnType<typeof buildCapability> | null = null;
  let reachable = false;
  let problem: string | null = null;

  if (registry.has(row.id)) {
    try {
      capability = buildCapability(await registry.get(row.id).getCapabilities());
      reachable = true;
    } catch (err) {
      problem = err instanceof Error ? err.message : '能力探测失败';
    }
  } else {
    problem = `本进程没有 ${row.runtimeKind} 的适配器实现，任务派不出去`;
  }

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description,
    status: row.status,
    pausedReason: row.pausedReason,
    ownerId: row.ownerId,

    runtimeKind: row.runtimeKind,
    runtimeKindLabel: spec?.label ?? row.runtimeKind,
    /** ★ 环境变量表里的加密值只回占位符，与凭证同一条纪律 */
    runtimeConfig: maskRuntimeConfig(row.runtimeConfig),
    /**
     * ★ 环境变量表里那些取不到值的引用。
     *   和 credentialProblem 是同一类问题：配置看着完好，派发时才炸，
     *   而报错不会指向「那个环境变量没设置」。
     */
    runtimeConfigProblems: describeEnvOverrides(envOverridesOf(row.runtimeConfig)),
    endpoint: row.endpoint,

    /** ★ 只回 hint 与可用性判断，永不回原值 */
    credentialHint: row.credentialHint,
    credentialUsable: cred.usable,
    credentialKind: cred.kind,
    credentialProblem: cred.problem,

    registered: registry.has(row.id),
    reachable,
    problem,
    lastCheckAt: row.lastCheckAt?.toISOString() ?? null,

    model: row.model,
    skills: row.skills,
    applicableTypes: row.applicableTypes,
    permissions: permissionsOf(row),
    maxConcurrency: row.maxConcurrency,
    timeoutSeconds: row.timeoutSeconds,
    costLimitPerRun: row.costLimitPerRun === null ? null : Number(row.costLimitPerRun),
    costLimitDaily: row.costLimitDaily === null ? null : Number(row.costLimitDaily),

    capability,
  };
}

function buildCapability(manifest: Parameters<typeof checkCompatibility>[0]) {
  const report = checkCompatibility(manifest);
  return {
    runtime: manifest.runtime,
    protocolVersion: manifest.protocolVersion,
    transport: manifest.transport,
    models: manifest.models,
    limits: manifest.limits,
    tools: manifest.tools,
    supported: report.supported,
    missing: report.missing,
    restricted: report.restricted,
  };
}

// ── 校验 ──────────────────────────────────────────────────────────────

function assertKind(kind: string) {
  if (!isKnownRuntimeKind(kind)) {
    throw new ApiError('VALIDATION_FAILED', `不支持的运行时类型：${kind}`, {
      supported: RUNTIME_KIND_SPECS.map((k) => k.kind),
    });
  }
  return runtimeKindSpec(kind)!;
}

/**
 * 校验运行时配置，并把环境变量表里的敏感值换成引用。
 *
 * @param previous 库里已有的那份配置，用于兑现 `secret://saved` 占位符。
 *   新建时传 null。
 */
function prepareConfig(
  kind: string,
  input: Record<string, unknown> | undefined,
  previous: Record<string, unknown> | null,
): { config: Record<string, unknown>; dropped: string[] } {
  const result = validateRuntimeConfig(kind, input);
  if (!result.ok) {
    /**
     * ★ 在保存这一刻拒掉，而不是放行。
     *   放行的表现是派发成功、CLI 启动时报一句没人看的参数错误，
     *   而界面上这个 Agent 显示为配置完好。
     */
    throw new ApiError('VALIDATION_FAILED', `运行时配置不合法：${result.issues[0]!.message}`, {
      issues: result.issues,
    });
  }

  // 该运行时没有环境变量表这一项（如 mock）时不要凭空塞一个 env 键进去
  if (!('env' in result.config)) return { config: result.config, dropped: result.dropped };

  try {
    return {
      config: {
        ...result.config,
        env: encodeEnvOverrides(envOverridesOf(result.config), envOverridesOf(previous)),
      },
      dropped: result.dropped,
    };
  } catch (err) {
    if (err instanceof SecretConfigError) throw new ApiError('VALIDATION_FAILED', err.message);
    throw err;
  }
}

/** 回显用：环境变量表里的加密值换成占位符，永不回显原文 */
function maskRuntimeConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (!('env' in config)) return config;
  return { ...config, env: maskEnvOverrides(envOverridesOf(config)) };
}

/**
 * 环境变量表里是不是已经给了凭证。
 *
 * ★ 只是「别让人存下一个明显跑不起来的 Agent」的粗筛：这里不知道每种 CLI
 *   认哪个变量名，就按「有没有敏感形状的键」判断。真正的判定在适配器的
 *   dispatch 里 —— 它知道自己认什么，也只有它拦得住。
 */
function credentialGivenInEnv(config: Record<string, unknown>): boolean {
  return Object.keys(envOverridesOf(config)).some(isSecretEnvKey);
}

function credentialColumns(credential: string | null) {
  if (credential === null) return { credentialRef: null, credentialHint: null };
  try {
    return { credentialRef: encodeSecret(credential), credentialHint: hintOf(credential) };
  } catch (err) {
    if (err instanceof SecretConfigError) throw new ApiError('VALIDATION_FAILED', err.message);
    throw err;
  }
}

async function assertOwner(db: Database, ownerId: string) {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, ownerId));
  if (!u) throw notFound('负责人');
}

/**
 * 权限自检。
 *
 * ★ 「授予了写工具但没有任何 repo:write 范围」这类组合不报错会很难查：
 *   Agent 看得到 Edit，试着用，被适配器挡下来，然后报告「权限不足」——
 *   而配置页上明明勾着 Edit。在配置时就说清楚。
 */
function assertPermissionsSane(p: {
  allowedTools: string[];
  deniedTools: string[];
  resourceScopes: ResourceScope[];
}) {
  const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
  const base = (t: string) => (t.includes('(') ? t.slice(0, t.indexOf('(')) : t).trim();

  const allowed = new Set(p.allowedTools.map(base));
  const deniedBare = new Set(p.deniedTools.filter((t) => !t.includes('(')).map(base));

  const wantsWrite = WRITE_TOOLS.some((t) => allowed.has(t) && !deniedBare.has(t));
  const hasWriteScope = p.resourceScopes.some((s) => s.kind === 'repo' && s.access === 'write');

  if (wantsWrite && !hasWriteScope) {
    throw new ApiError(
      'VALIDATION_FAILED',
      '授予了写文件的工具，但没有任何可写的代码仓库范围 —— 这样配置出来的 Agent 一动手就会被拒',
      { hint: '要么去掉写类工具，要么给一个 access=write 的 repo 资源范围' },
    );
  }

  const conflict = p.allowedTools.filter((t) => deniedBare.has(base(t)));
  if (conflict.length > 0) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `以下工具同时出现在允许与禁止列表中：${conflict.join('、')}。黑名单优先级更高，它们实际不可用`,
      { conflict },
    );
  }

  if (p.allowedTools.length === 0) {
    throw new ApiError('VALIDATION_FAILED', '至少要授予一个工具，否则这个 Agent 什么都做不了');
  }
}

function permissionsOf(row: AgentRow): AgentPermissions {
  return {
    allowedTools: row.allowedTools,
    deniedTools: row.deniedTools,
    resourceScopes: row.resourceScopes,
  };
}

/**
 * 权限改动的方向：只要有任何一项变宽就算 grant。
 *
 * ★ 判据本身在 @apos/domain（agentPermissionChangeDirection）—— 与 Policy 的
 *   收紧/放宽判定同源。这个方向同时决定三件事：要不要填原因、
 *   审计里怎么记、以及需要哪一档权限（§2.3 的不对称设计）。
 *   三处用三份判据的话，总有一处会和另外两处说的不一样。
 */
function directionOf(before: AgentPermissions, after: AgentPermissions): 'grant' | 'revoke' {
  return agentPermissionChangeDirection(before, after) === 'loosen' ? 'grant' : 'revoke';
}
