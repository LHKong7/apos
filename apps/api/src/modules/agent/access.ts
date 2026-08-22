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
import { fail, notFound } from '../../http/errors';

/**
 * Project-level Agent permissions — read, preview and save all share **one**
 * evaluator / 项目级 Agent 权限。
 *
 * ★★ Preview and save must reach the same conclusion.
 *
 *   With one evaluation on each side, the promise "we tell you what will happen
 *   before you save" quietly stops holding — and it fails in the least visible
 *   way possible: the preview says nothing changes, the save changes the
 *   permissions, and both records look internally consistent. This whole module
 *   calls the evaluator in exactly one place; the only difference between
 *   preview and save is whether the result is written to the database.
 */

export const AgentAccessInput = z.object({
  profileKey: z.string(),
  /**
   * Capabilities added to or removed from the profile one at a time / 在档案之上
   * 单加、单减的能力。
   *
   * ★ The default UI should not surface these — picking a profile is enough.
   *   The escape hatch exists because "the profile is short by exactly one
   *   capability" is a real need that will come up, and without it the user's
   *   only move is to pick a wider profile — granting five extra capabilities
   *   to get the one they needed.
   */
  addCapabilities: z.array(AgentCapability).default([]),
  removeCapabilities: z.array(AgentCapability).default([]),
  resourceScopes: z.array(ResourceScope).default([]),
  reason: z.string().nullable().default(null),
});
export type AgentAccessInput = z.infer<typeof AgentAccessInput>;

/** Validate capability names read from the database — after a catalog rename, the strings in old rows are no longer valid capabilities */
function knownCapabilities(values: readonly string[]): Capability[] {
  return sortCapabilities(values.filter(isAgentCapability));
}

/**
 * Reads this Agent's grant inside one project; null means never configured /
 * 读某个项目里这个 Agent 的授权，null = 没配过。
 *
 * ★ "Never configured" and "configured to be empty" have to stay separable: the
 *   first falls back to the default profile, the second means "not a single
 *   capability". Returning null rather than an empty object is what makes it
 *   impossible for a caller to conflate them.
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

/** Batch read — the scheduler evaluates every Agent in a project, and one query each would be an N+1 */
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
     * ★ NULL means no ceiling at all. An empty array means not one capability.
     *   The two mean opposite things, and this line is the only place the
     *   distinction gets expressed — the moment anywhere else treats null as an
     *   empty array, every Agent without a ceiling loses all of its
     *   capabilities at once.
     */
    allowedCapabilities:
      agent.capabilityCeiling === null ? null : knownCapabilities(agent.capabilityCeiling),
    deniedCapabilities: knownCapabilities(agent.deniedCapabilities),
  };
}

/** Repository refs registered and active for this project — Agents in the project can read them by default */
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
  /** Pre-fetched project repository refs; queried on the spot when omitted */
  repoRefs?: readonly string[];
  /** Overrides the stored grant — preview uses it to compute what saving would do */
  grantOverride?: ExpandedProfile | null;
  scopeOverride?: readonly ResourceScope[];
}

/**
 * Resolves one Agent's effective permissions inside one project / 求出某个 Agent
 * 在某个项目里的生效权限。
 *
 * ★★ This is the **only** entry point for all three paths: the API, the
 *   scheduler's candidate matching, and dispatch. What separate implementations
 *   cost is spelled out at the top of domain/capabilities/evaluate.ts.
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
   * ★★ With no project grant, the resource scopes are **empty** — there is no
   *   fallback to the old field on the Agent row.
   *
   *   That field is organization-level, so falling back to it would mean "a
   *   repository granted in project A also counts in project B", which is
   *   exactly what moving permissions down to project scope removes. Migration
   *   0031 already backfilled a grant row for every existing in-project Agent,
   *   so a fallback would only mask the ones it missed.
   *
   *   Empty does not mean blind: repositories registered on the project stay
   *   readable by default (the projectRepoRefs tier below), so an Agent that
   *   just joined and has no grant configured can still read the project's code.
   */
  const scopes = row?.resourceScopes ?? [];

  /**
   * ★★ The translator depends on the **runtime kind** alone, and not at all on
   *   whether that runtime is registered in this process.
   *
   *   The two were once conflated, and the cost was that the scheduler — which
   *   carries no registry — translated every Agent to an empty tool set. Every
   *   Agent was then judged to be "missing the required tool permissions", and
   *   work sat silently in ready. "What this CLI can do" is an intrinsic
   *   property of it; "is it loaded in this process right now" is a separate
   *   question, answered by the candidate's `registered` flag.
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
  // ★ Out-of-org and nonexistent both return 404: a 403 turns the id into an enumeration probe
  if (!agent || agent.orgId !== ctx.orgId) throw notFound('agent');

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
    throw fail(
      'VALIDATION_FAILED',
      'agent.not_project_member',
      `${agent.name} 不是这个项目的成员 —— 先在「成员与角色」里把它加进来`,
      { params: { name: agent.name }, details: { agentId } },
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
  /** True when nothing was ever stored — the UI says "using the default profile" instead of rendering a fake configuration */
  usingDefault: boolean;
  /** Whether the selected profile has a newer version; the UI announces it but does **not** auto-upgrade */
  profileOutdated: boolean;
  capabilities: Capability[];
  deniedCapabilities: Capability[];
  resourceScopes: ResourceScope[];
  sources: EffectiveAgentAccess['sources'];
  warnings: string[];
  /** Capability consequences already rendered in plain language, so the UI need not consult the catalog */
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
     * ★ Announce only, never auto-upgrade. Auto-upgrading would mean "the
     *   platform edits one profile and every Agent widens with it" — the
     *   textbook way permission creep happens.
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
 * What things will look like after saving / 「保存之后会变成什么样」。
 *
 * ★★ Shares one computation path with {@link setAgentAccess}: the preview calls
 *   this function, and so does the save (it takes the `direction` from here to
 *   decide which permission to demand). The two therefore cannot reach
 *   different conclusions — that is guaranteed by there being one
 *   implementation, not by anyone's discipline.
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
    throw fail(
      'VALIDATION_FAILED',
      'agent.unknown_capability_profile',
      `没有名为「${input.profileKey}」的能力档案`,
      { params: { profileKey: input.profileKey }, details: { profileKey: input.profileKey, known: BUILTIN_CAPABILITY_PROFILES.map((p) => p.key), } },
    );
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
     * ★ Runtime degradation warnings ship alongside. "This capability does not
     *   take effect on this runtime" is the single most useful thing to know
     *   before saving, and it is not part of "impact of the change" — leave the
     *   two lists unmerged and the user sees a green "granted" in the preview
     *   while nothing at all will actually happen.
     */
    warnings: [...impact.warnings, ...after.warnings],
    next,
  };
}

/**
 * Saves the project-level grant / 保存项目级授权。
 *
 * ★ Governance — which permission is required, whether a reason is mandatory —
 *   runs in executeGovernedMutation in a fixed order. All this code does is
 *   work out the direction and write the row.
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
   * ★ Governance is injected by the caller rather than calling rbac here. This
   *   module has to be unit-testable without the HTTP layer (the decision is
   *   pure and the write is its own business), and rbac cannot run without a
   *   FastifyRequest.
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
