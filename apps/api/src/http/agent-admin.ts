import { and, count, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  agentPermissionChanges,
  agentRuns,
  agentRuntimes,
  agents,
  users,
  workItems,
  type Database,
} from '@apos/db';
import {
  ACTIVE_RUN_STATUSES,
  ResourceScope,
  WorkItemType,
  type AgentPermissions,
} from '@apos/contracts';
import { checkCompatibility, type RuntimeRegistry } from '@apos/agent-runtimes';
import {
  isKnownKind,
  registerNow,
  RUNTIME_KINDS,
  type RuntimeRow,
} from '../modules/agent/runtime-factory';
import { describeRef, encodeSecret, hasMasterKey, hintOf, SecretConfigError } from '../modules/security/secrets';
import { ApiError, notFound } from './errors';

/**
 * 运行时接入 与 Agent 档案的写入侧（页面文档 08 §5.5）。
 *
 * ★ 信息架构刻意分成三块，不做成一个巨型配置页：
 *
 *   | 块 | 管什么 | 层级 |
 *   | --- | --- | --- |
 *   | 运行时接入 | kind / 凭证 / 能力 | 组织级，一次配置多处复用 |
 *   | Agent 档案 | 人设 / 工具 / 资源范围 / 成本上限 / 负责人 | 组织级，每个 Agent 一份 |
 *   | 项目工程约定 | 编码规范、仓库登记 | 项目级（见 project-config.ts） |
 *
 *   揉在一起的后果很具体：加一个新 code agent 要重填一遍工具白名单和工程约定。
 *
 * ★ 凭证从不出现在任何响应里，只回 hint。见 modules/security/secrets.ts。
 */

// ── 运行时接入 ────────────────────────────────────────────────────────

export const RuntimeInput = z.object({
  name: z.string().min(1, '运行时名称不能为空').max(80),
  kind: z.string().min(1),
  /** 自建网关地址；官方端点留空 */
  endpoint: z.string().url('接入地址必须是合法 URL').nullable().optional(),
  /**
   * 明文凭证或 `env:变量名`。只在创建/轮换时出现，服务端立刻编码成引用。
   * 不传 = 不改动现有凭证；传 null = 清除。
   */
  credential: z.string().nullable().optional(),
});
export type RuntimeInput = z.infer<typeof RuntimeInput>;

/** 页面上的「新增接入」下拉选项 —— 与工厂同源，不会出现选了却建不出来的类型 */
export function listRuntimeKinds() {
  return {
    kinds: RUNTIME_KINDS.map((k) => ({ ...k })),
    /** 没有主密钥时页面要引导用户改用 env: 形态，而不是让他填完才报错 */
    canStoreInlineCredential: hasMasterKey(),
    credentialHelp:
      '推荐填 `env:变量名`（凭证只留在进程环境，不进数据库）。' +
      '直接粘贴 key 需要部署时配置 APOS_SECRET_KEY，密文进库、钥匙在库外。',
  };
}

export async function createRuntime(
  db: Database,
  registry: RuntimeRegistry,
  orgId: string,
  input: RuntimeInput,
): Promise<{ runtime: unknown }> {
  if (!isKnownKind(input.kind)) {
    throw new ApiError('VALIDATION_FAILED', `不支持的运行时类型：${input.kind}`, {
      supported: RUNTIME_KINDS.map((k) => k.kind),
    });
  }

  const spec = RUNTIME_KINDS.find((k) => k.kind === input.kind)!;
  const credential = input.credential?.trim() || null;

  if (spec.needsCredential && !credential) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `${spec.label} 需要凭证（${spec.credentialLabel}）。可填 \`env:变量名\` 让凭证留在进程环境里。`,
    );
  }

  const [row] = await db
    .insert(agentRuntimes)
    .values({
      orgId,
      name: input.name.trim(),
      kind: input.kind,
      endpoint: input.endpoint ?? null,
      ...credentialColumns(credential),
      status: 'active',
    })
    .returning();

  // ★ 立刻注册，不等下一轮同步 —— 否则新建的运行时在 15 秒内是隐形的，
  //   用户会以为「建了但没用」，而界面只会说「适配器没有在当前进程注册」
  registerNow(registry, row!);

  return { runtime: await describeRuntime(db, registry, row!) };
}

export async function updateRuntime(
  db: Database,
  registry: RuntimeRegistry,
  runtimeId: string,
  input: Partial<RuntimeInput> & { status?: 'active' | 'disabled'; statusReason?: string },
) {
  const [existing] = await db
    .select()
    .from(agentRuntimes)
    .where(eq(agentRuntimes.id, runtimeId));
  if (!existing) throw notFound('运行时');

  const credential = input.credential === undefined ? undefined : input.credential?.trim() || null;

  const [row] = await db
    .update(agentRuntimes)
    .set({
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.endpoint !== undefined ? { endpoint: input.endpoint ?? null } : {}),
      ...(credential !== undefined ? credentialColumns(credential) : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.statusReason !== undefined ? { statusReason: input.statusReason } : {}),
      updatedAt: new Date(),
    })
    .where(eq(agentRuntimes.id, runtimeId))
    .returning();

  // 换了凭证/地址就得换掉进程里那个实例，否则改完仍在用旧 key
  registerNow(registry, row!);

  return { runtime: await describeRuntime(db, registry, row!) };
}

export async function deleteRuntime(db: Database, runtimeId: string) {
  const [row] = await db.select().from(agentRuntimes).where(eq(agentRuntimes.id, runtimeId));
  if (!row) throw notFound('运行时');

  const using = await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.runtimeId, runtimeId));
  if (using.length > 0) {
    throw new ApiError(
      'VERSION_CONFLICT',
      `还有 ${using.length} 个 Agent 挂在这个运行时上，删除会让它们立刻派不出任务`,
      { agents: using.map((a) => a.name) },
    );
  }

  await db.delete(agentRuntimes).where(eq(agentRuntimes.id, runtimeId));
  return { ok: true as const };
}

/**
 * 能力探测。
 *
 * ★ 「适配器没注册」「注册了但连不上」「连上了但缺能力」是三件不同的事，
 *   页面必须分别显示 —— 混成一句「不可用」，用户不知道该去装依赖、
 *   换 key，还是换个 Agent 跑高风险任务。
 */
export async function probeRuntime(db: Database, registry: RuntimeRegistry, runtimeId: string) {
  const [row] = await db.select().from(agentRuntimes).where(eq(agentRuntimes.id, runtimeId));
  if (!row) throw notFound('运行时');

  const result = await describeRuntime(db, registry, row);

  await db
    .update(agentRuntimes)
    .set({
      lastCheckAt: new Date(),
      ...(result.capability
        ? { capabilities: result.capability as unknown as Record<string, unknown>, protocolVersion: result.capability.protocolVersion }
        : {}),
    })
    .where(eq(agentRuntimes.id, runtimeId));

  return result;
}

async function describeRuntime(db: Database, registry: RuntimeRegistry, row: RuntimeRow) {
  const cred = describeRef(row.credentialRef);
  const usedBy = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.runtimeId, row.id));

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
    problem = `本进程没有 ${row.kind} 的适配器实现，任务派不出去`;
  }

  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    endpoint: row.endpoint,
    status: row.status,
    statusReason: row.statusReason,
    protocolVersion: row.protocolVersion,

    /** ★ 只回 hint 与可用性判断，永不回原值 */
    credentialHint: row.credentialHint,
    credentialUsable: cred.usable,
    credentialKind: cred.kind,
    credentialProblem: cred.problem,

    registered: registry.has(row.id),
    reachable,
    problem,
    lastCheckAt: row.lastCheckAt?.toISOString() ?? null,

    agentCount: usedBy.length,
    agentNames: usedBy.map((a) => a.name),
    capability,
  };
}

export async function listRuntimesAdmin(db: Database, registry: RuntimeRegistry, orgId: string) {
  const rows = await db
    .select()
    .from(agentRuntimes)
    .where(eq(agentRuntimes.orgId, orgId))
    .orderBy(agentRuntimes.createdAt);

  return {
    runtimes: await Promise.all(rows.map((r) => describeRuntime(db, registry, r))),
    ...listRuntimeKinds(),
  };
}

function credentialColumns(credential: string | null) {
  if (credential === null) return { credentialRef: null, credentialHint: null };
  try {
    return { credentialRef: encodeSecret(credential), credentialHint: hintOf(credential) };
  } catch (err) {
    if (err instanceof SecretConfigError) {
      throw new ApiError('VALIDATION_FAILED', err.message);
    }
    throw err;
  }
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

// ── Agent 档案 ────────────────────────────────────────────────────────

export const AgentInput = z.object({
  name: z.string().min(1, 'Agent 名称不能为空').max(80),
  type: z.string().min(1),
  description: z.string().nullable().optional(),
  runtimeId: z.string().uuid('必须选择一个运行时'),
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
  orgId: string,
  input: AgentInput,
  actorUserId: string,
) {
  await assertRuntime(db, orgId, input.runtimeId);
  await assertOwner(db, input.ownerId);
  assertPermissionsSane(input);

  const [row] = await db
    .insert(agents)
    .values({
      orgId,
      name: input.name.trim(),
      type: input.type,
      description: input.description ?? null,
      runtimeId: input.runtimeId,
      runtimeRef: input.name.trim(),
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

  // 建档本身就是一次权限授予，同样要留痕
  await db.insert(agentPermissionChanges).values({
    agentId: row!.id,
    changedBy: actorUserId,
    direction: 'grant',
    before: { allowedTools: [], deniedTools: [], resourceScopes: [] },
    after: permissionsOf(row!),
    reason: '创建 Agent',
  });

  return { agent: row };
}

export async function updateAgent(
  db: Database,
  agentId: string,
  input: Partial<AgentInput> & { reason?: string },
  actorUserId: string,
) {
  const [existing] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!existing) throw notFound('Agent');

  if (input.runtimeId) await assertRuntime(db, existing.orgId, input.runtimeId);
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
  if (direction === 'grant' && !input.reason?.trim()) {
    throw new ApiError('VALIDATION_FAILED', '放宽 Agent 权限必须填写原因');
  }

  const [row] = await db
    .update(agents)
    .set({
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
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

  return { agent: row, permissionsChanged };
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

async function assertRuntime(db: Database, orgId: string, runtimeId: string) {
  const [rt] = await db.select().from(agentRuntimes).where(eq(agentRuntimes.id, runtimeId));
  if (!rt || rt.orgId !== orgId) throw notFound('运行时');
  if (rt.status !== 'active') {
    throw new ApiError('VALIDATION_FAILED', `运行时「${rt.name}」已停用，不能挂新的 Agent`);
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
    // 黑名单优先，不是错误，但用户以为自己授权了
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

function permissionsOf(row: typeof agents.$inferSelect): AgentPermissions {
  return {
    allowedTools: row.allowedTools,
    deniedTools: row.deniedTools,
    resourceScopes: row.resourceScopes,
  };
}

/** 放宽还是收紧：只要有任何一项变宽就算 grant */
function directionOf(before: AgentPermissions, after: AgentPermissions): 'grant' | 'revoke' {
  const beforeTools = new Set(before.allowedTools);
  const widened = after.allowedTools.some((t) => !beforeTools.has(t));

  const beforeScopes = new Map(before.resourceScopes.map((s) => [`${s.kind}:${s.ref}`, s.access]));
  const RANK = { none: 0, read: 1, write: 2 } as const;
  const scopeWidened = after.resourceScopes.some(
    (s) => RANK[s.access] > RANK[beforeScopes.get(`${s.kind}:${s.ref}`) ?? 'none'],
  );

  const beforeDenied = new Set(before.deniedTools);
  const denyRemoved = before.deniedTools.some((t) => !after.deniedTools.includes(t)) && beforeDenied.size > 0;

  return widened || scopeWidened || denyRemoved ? 'grant' : 'revoke';
}
