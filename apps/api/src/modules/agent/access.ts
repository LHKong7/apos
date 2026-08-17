import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  agents,
  projectAgentPermissions,
  projectMembers,
  repositories,
  type Database,
} from '@apos/db';
import {
  AgentCapability,
  isAgentCapability,
  ResourceScope,
  type AgentCapability as Capability,
} from '@apos/contracts';
import {
  BUILTIN_CAPABILITY_PROFILES,
  CAPABILITY_SPECS,
  capabilityChangeImpact,
  capabilityProfile,
  DEFAULT_PROFILE_KEY,
  expandProfile,
  resolveEffectiveAgentAccess,
  sortCapabilities,
  type AgentCeiling,
  type EffectiveAgentAccess,
  type ExpandedProfile,
} from '@apos/domain';
import { capabilityTranslator } from '@apos/agent-runtimes';
import { ApiError, notFound } from '../../http/errors';

/**
 * 项目级 Agent 权限 —— 读、预览、保存，三件事共用**同一个**求值器。
 *
 * ★★ 预览与保存必须给出同一个结论。
 *
 *   两边各算一套的话，「保存前告诉你会发生什么」这个承诺就失效了 ——
 *   而它失效的方式最难发现：预览说「不会有变化」，保存之后权限变了，
 *   两条记录都各自自洽。这一整个模块只有一处调用求值器，
 *   preview 与 save 的差别仅仅是「写不写库」。
 *
 * The read, preview and save paths share one evaluator. Two evaluators would
 * break the promise the preview makes, and break it in the least visible way:
 * the preview says nothing changes, the save changes something, and both
 * records look internally consistent.
 */

export const AgentAccessInput = z.object({
  profileKey: z.string(),
  /**
   * 在档案之上单加/单减的能力。
   *
   * ★ 默认界面不该出现它们（选档案就够了）。留这个口子是因为「档案差一条」
   *   的真实需求一定会出现，而没有口子时用户的办法是选一个更宽的档案 ——
   *   那等于为了一条能力多授出去五条。
   */
  addCapabilities: z.array(AgentCapability).default([]),
  removeCapabilities: z.array(AgentCapability).default([]),
  resourceScopes: z.array(ResourceScope).default([]),
  reason: z.string().nullable().default(null),
});
export type AgentAccessInput = z.infer<typeof AgentAccessInput>;

/** 库里存的能力名过一道校验 —— 目录改名之后，旧行里的字符串不再是合法能力 */
function knownCapabilities(values: readonly string[]): Capability[] {
  return sortCapabilities(values.filter(isAgentCapability));
}

/**
 * 读某个项目里这个 Agent 的授权。null = 没配过。
 *
 * ★ 「没配过」与「配成空」必须分得开：前者用默认档案，后者是「一条都不给」。
 *   返回 null 而不是一个空对象，就是为了让调用方没法把两者混起来。
 */
export async function loadProjectGrant(
  db: Database,
  projectId: string,
  agentId: string,
): Promise<ExpandedProfile | null> {
  const [row] = await db
    .select()
    .from(projectAgentPermissions)
    .where(
      and(
        eq(projectAgentPermissions.projectId, projectId),
        eq(projectAgentPermissions.agentId, agentId),
      ),
    );
  return row ? toExpanded(row) : null;
}

function toExpanded(row: typeof projectAgentPermissions.$inferSelect): ExpandedProfile {
  return {
    profileKey: row.profileKey,
    profileVersion: row.profileVersion,
    allowedCapabilities: knownCapabilities(row.allowedCapabilities),
    deniedCapabilities: knownCapabilities(row.deniedCapabilities),
  };
}

/** 批量读 —— 调度器要对一个项目里所有 Agent 求值，逐个查会变成 N+1 */
export async function loadProjectGrants(
  db: Database,
  projectId: string,
  agentIds: readonly string[],
): Promise<Map<string, ExpandedProfile>> {
  if (agentIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(projectAgentPermissions)
    .where(
      and(
        eq(projectAgentPermissions.projectId, projectId),
        inArray(projectAgentPermissions.agentId, [...agentIds]),
      ),
    );
  return new Map(rows.map((r) => [r.agentId, toExpanded(r)]));
}

export type AgentRow = typeof agents.$inferSelect;

export function ceilingOf(agent: Pick<AgentRow, 'capabilityCeiling' | 'deniedCapabilities'>): AgentCeiling {
  return {
    /**
     * ★ NULL = 不设上限。空数组 = 一条都不给。两者含义相反，
     *   而这个区别只有在这一行代码里表达得出来 —— 别处一旦把 null
     *   当成空数组，所有没设上限的 Agent 会瞬间失去全部能力。
     */
    allowedCapabilities:
      agent.capabilityCeiling === null ? null : knownCapabilities(agent.capabilityCeiling),
    deniedCapabilities: knownCapabilities(agent.deniedCapabilities),
  };
}

/** 项目级登记且启用的仓库 ref —— 它们对项目内 Agent 默认只读 */
export async function projectRepoRefs(
  db: Database,
  orgId: string,
  projectId: string,
): Promise<string[]> {
  const rows = await db
    .select({ ref: repositories.ref })
    .from(repositories)
    .where(
      and(
        eq(repositories.orgId, orgId),
        eq(repositories.projectId, projectId),
        eq(repositories.status, 'active'),
      ),
    );
  return rows.map((r) => r.ref);
}

export interface ResolveContext {
  orgId: string;
  projectId: string;
  /** 预算好的项目仓库 ref；不传就现查 */
  repoRefs?: readonly string[];
  /** 覆盖库里那份授权 —— preview 用它算「保存之后会怎样」 */
  grantOverride?: ExpandedProfile | null;
  scopeOverride?: readonly ResourceScope[];
}

/**
 * 求出某个 Agent 在某个项目里的生效权限。
 *
 * ★★ 这是 API、调度器匹配、派发三条路径**唯一**的入口。
 *   分头实现的代价见 domain/capabilities/evaluate.ts 开头那段。
 */
export async function resolveAgentAccess(
  db: Database,
  agent: AgentRow,
  ctx: ResolveContext,
): Promise<EffectiveAgentAccess> {
  const grant =
    ctx.grantOverride !== undefined
      ? ctx.grantOverride
      : await loadProjectGrant(db, ctx.projectId, agent.id);

  const [row] = ctx.scopeOverride
    ? [{ resourceScopes: [...ctx.scopeOverride] }]
    : grant
      ? await db
          .select({ resourceScopes: projectAgentPermissions.resourceScopes })
          .from(projectAgentPermissions)
          .where(
            and(
              eq(projectAgentPermissions.projectId, ctx.projectId),
              eq(projectAgentPermissions.agentId, agent.id),
            ),
          )
      : [undefined];

  /**
   * ★★ 迁移期的回落：项目里没配过时，用 Agent 上那份旧的 resourceScopes。
   *
   *   直接给空数组的话，升级之后所有还没被补过项目授权的 Agent 会失去
   *   全部资源范围 —— 表现是任务在「找不到仓库」上失败，而没人改过配置。
   *   这条回落随 Phase 5 一起去掉（届时旧字段停写）。
   */
  const scopes = row?.resourceScopes ?? (grant ? [] : agent.resourceScopes);

  /**
   * ★★ 翻译器只取决于**运行时类型**，与「有没有注册进本进程」无关。
   *
   *   这两件事曾经被混成一件，代价是调度器（它不带注册表）算出来的
   *   工具集是空的 —— 于是每个 Agent 都被判成「缺少所需工具权限」，
   *   任务安静地停在 ready。「这个 CLI 能做什么」是它的固有属性；
   *   「它此刻在不在本进程里」是另一个问题，由候选的 registered 那一栏回答。
   *
   * A translator depends on the runtime kind alone — whether that runtime is
   * registered in this process is a different question, answered by the
   * candidate's `registered` flag. Conflating them made the scheduler (which
   * carries no registry) translate every agent to an empty tool set.
   */
  return resolveEffectiveAgentAccess({
    projectGrant: grant,
    projectResourceScopes: scopes,
    projectRepoRefs: ctx.repoRefs ?? (await projectRepoRefs(db, ctx.orgId, ctx.projectId)),
    agentCeiling: ceilingOf(agent),
    translator: capabilityTranslator(agent.runtimeKind),
  });
}

async function loadOwnedAgentInProject(
  db: Database,
  ctx: { orgId: string; projectId: string },
  agentId: string,
): Promise<AgentRow> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  // ★ 越界与不存在都回 404：403 会把 id 变成可枚举的探针
  if (!agent || agent.orgId !== ctx.orgId) throw notFound('Agent');

  const [member] = await db
    .select({ actorId: projectMembers.actorId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, ctx.projectId),
        eq(projectMembers.actorType, 'agent'),
        eq(projectMembers.actorId, agentId),
      ),
    );
  if (!member) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `${agent.name} 不是这个项目的成员 —— 先在「成员与角色」里把它加进来`,
      { agentId },
    );
  }

  return agent;
}

export interface AgentAccessView {
  agentId: string;
  agentName: string;
  runtimeKind: string;
  profileKey: string;
  profileVersion: number;
  /** 库里没配过时为 true —— 界面据此说「用的是默认档案」而不是显示一份假配置 */
  usingDefault: boolean;
  /** 选中的档案有没有出新版；有的话界面提示，但**不自动升级** */
  profileOutdated: boolean;
  capabilities: Capability[];
  deniedCapabilities: Capability[];
  resourceScopes: ResourceScope[];
  sources: EffectiveAgentAccess['sources'];
  warnings: string[];
  /** 已渲染成人话的能力后果，界面直接显示，不需要再查目录 */
  explained: { capability: Capability; label: string; labelEn: string; risk: string }[];
  profiles: {
    key: string;
    name: string;
    nameEn: string;
    description: string;
    descriptionEn: string;
  }[];
}

export async function getAgentAccess(
  db: Database,
  ctx: { orgId: string; projectId: string },
  agentId: string,
): Promise<AgentAccessView> {
  const agent = await loadOwnedAgentInProject(db, ctx, agentId);
  const grant = await loadProjectGrant(db, ctx.projectId, agentId);
  const access = await resolveAgentAccess(db, agent, {
    ...ctx,
    grantOverride: grant,
  });

  const builtin = capabilityProfile(access.profileKey);

  return {
    agentId,
    agentName: agent.name,
    runtimeKind: agent.runtimeKind,
    profileKey: access.profileKey,
    profileVersion: access.profileVersion,
    usingDefault: grant === null,
    /**
     * ★ 只提示，不自动升级。自动升级等于「平台改一次档案，
     *   所有 Agent 跟着变宽」—— 权限累积最典型的发生方式。
     */
    profileOutdated: builtin !== null && builtin.version > access.profileVersion,
    capabilities: access.capabilities,
    deniedCapabilities: access.deniedCapabilities,
    resourceScopes: access.runtimePermissions.resourceScopes,
    sources: access.sources,
    warnings: access.warnings,
    explained: access.capabilities.map((c) => ({
      capability: c,
      label: CAPABILITY_SPECS[c].label,
      labelEn: CAPABILITY_SPECS[c].labelEn,
      risk: CAPABILITY_SPECS[c].risk,
    })),
    profiles: BUILTIN_CAPABILITY_PROFILES.map((p) => ({
      key: p.key,
      name: p.name,
      nameEn: p.nameEn,
      description: p.description,
      descriptionEn: p.descriptionEn,
    })),
  };
}

export interface AgentAccessPreview {
  direction: 'loosen' | 'tighten' | 'neutral';
  addedCapabilities: Capability[];
  removedCapabilities: Capability[];
  affectedResources: string[];
  requiresReason: boolean;
  warnings: string[];
}

/**
 * 「保存之后会变成什么样」。
 *
 * ★★ 与 {@link setAgentAccess} 走同一条计算路径：预览调这个函数，
 *   保存也调这个函数（拿它的 direction 去要权限）。所以两者不可能给出
 *   不同的结论 —— 这不是靠纪律保证的，是靠只有一份实现保证的。
 */
export async function previewAgentAccess(
  db: Database,
  ctx: { orgId: string; projectId: string },
  agentId: string,
  input: AgentAccessInput,
): Promise<AgentAccessPreview & { next: ExpandedProfile }> {
  const agent = await loadOwnedAgentInProject(db, ctx, agentId);
  const profile = capabilityProfile(input.profileKey);
  if (!profile) {
    throw new ApiError('VALIDATION_FAILED', `没有名为「${input.profileKey}」的能力档案`, {
      profileKey: input.profileKey,
      known: BUILTIN_CAPABILITY_PROFILES.map((p) => p.key),
    });
  }

  const next = expandProfile(profile, {
    add: input.addCapabilities,
    remove: input.removeCapabilities,
  });

  const repoRefs = await projectRepoRefs(db, ctx.orgId, ctx.projectId);
  const before = await resolveAgentAccess(db, agent, { ...ctx, repoRefs });
  const after = await resolveAgentAccess(db, agent, {
    ...ctx,
    repoRefs,
    grantOverride: next,
    scopeOverride: input.resourceScopes,
  });

  const impact = capabilityChangeImpact(
    {
      capabilities: before.capabilities,
      deniedCapabilities: before.deniedCapabilities,
      resourceScopes: before.runtimePermissions.resourceScopes,
    },
    {
      capabilities: after.capabilities,
      deniedCapabilities: after.deniedCapabilities,
      resourceScopes: after.runtimePermissions.resourceScopes,
    },
  );

  return {
    ...impact,
    /**
     * ★ 运行时降级警告要一起给出来。「这条能力在这个运行时上不生效」
     *   是保存前最该知道的一件事，而它不属于「改动影响」——
     *   不合并的话，用户会在预览里看到一条绿色的「已授予」，
     *   而实际什么也不会发生。
     */
    warnings: [...impact.warnings, ...after.warnings],
    next,
  };
}

/**
 * 保存项目级授权。
 *
 * ★ 治理（要哪条权限、要不要填原因）由 executeGovernedMutation 按固定顺序跑，
 *   这里只负责「算出方向」与「写库」。
 */
export interface AgentAccessSaveResult {
  ok: true;
  direction: 'loosen' | 'tighten' | 'neutral';
  profileKey: string;
  profileVersion: number;
  addedCapabilities: Capability[];
  removedCapabilities: Capability[];
  warnings: string[];
}

export async function setAgentAccess(
  db: Database,
  ctx: { orgId: string; projectId: string; userId: string },
  agentId: string,
  input: AgentAccessInput,
  /**
   * ★ 治理这一段由调用方注入，而不是这里直接调 rbac。
   *   这个模块要能脱离 HTTP 层单测（判定是纯的，写库是它自己的事），
   *   而 rbac 需要一个 FastifyRequest 才活得起来。
   */
  governed: (args: {
    direction: 'loosen' | 'tighten' | 'neutral';
    reason: string | null;
    mutate: () => Promise<AgentAccessSaveResult>;
  }) => Promise<AgentAccessSaveResult>,
): Promise<AgentAccessSaveResult> {
  const preview = await previewAgentAccess(db, ctx, agentId, input);

  return governed({
    direction: preview.direction,
    reason: input.reason,
    mutate: async () => {
      await db
        .insert(projectAgentPermissions)
        .values({
          orgId: ctx.orgId,
          projectId: ctx.projectId,
          agentId,
          profileKey: preview.next.profileKey,
          profileVersion: preview.next.profileVersion,
          allowedCapabilities: preview.next.allowedCapabilities,
          deniedCapabilities: preview.next.deniedCapabilities,
          resourceScopes: input.resourceScopes,
          updatedBy: ctx.userId,
        })
        .onConflictDoUpdate({
          target: [projectAgentPermissions.projectId, projectAgentPermissions.agentId],
          set: {
            profileKey: preview.next.profileKey,
            profileVersion: preview.next.profileVersion,
            allowedCapabilities: preview.next.allowedCapabilities,
            deniedCapabilities: preview.next.deniedCapabilities,
            resourceScopes: input.resourceScopes,
            updatedBy: ctx.userId,
            updatedAt: new Date(),
          },
        });

      return {
        ok: true as const,
        direction: preview.direction,
        profileKey: preview.next.profileKey,
        profileVersion: preview.next.profileVersion,
        addedCapabilities: preview.addedCapabilities,
        removedCapabilities: preview.removedCapabilities,
        warnings: preview.warnings,
      };
    },
  });
}

export { DEFAULT_PROFILE_KEY };
