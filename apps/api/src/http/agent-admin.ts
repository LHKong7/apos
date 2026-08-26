import { and, count, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  agentPermissionChanges,
  agentRuns,
  agents,
  projectAgentBindings,
  projectMembers,
  projects,
  requirements,
  users,
  workItems,
  type Database,
} from '@apos/db';
import {
  ACTIVE_RUN_STATUSES,
  AGENT_CAPABILITIES,
  AgentCapability,
  envOverridesOf,
  isKnownRuntimeKind,
  isSecretEnvKey,
  RUNTIME_KIND_SPECS,
  runtimeKindSpec,
  validateRuntimeConfig,
} from '@apos/contracts';
import { CAPABILITY_SPECS, capabilityChangeImpact } from '@apos/domain';
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
import { fail, notFound } from './errors';

/**
 * Agent profiles — create N agents, each carrying its own headless CLI kind and its own
 * personalized configuration.
 *
 * ★ There is no separate "runtime connection" layer. An agent *is* "one CLI + one set of
 *   its parameters + one credential + one set of capabilities" — a complete, usable
 *   execution subject. Adding an agent is therefore filling in one form, instead of first
 *   creating a connection somewhere else and coming back to attach it.
 *
 * ★ The price is that the same key gets referenced once per agent. The mitigations are
 *   written into the UI guidance: with the `env:VAR_NAME` form, N agents point at the same
 *   variable name, so rotation still touches exactly one place; and `credentialUsage`
 *   aggregates "who is using this credential".
 *
 * ★ Credentials never appear in any response — only a hint does. See
 *   modules/security/secrets.ts.
 *
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

// ── Platform configuration catalog ────────────────────────────────────

/**
 * What each CLI kind can be configured with, defined once by the platform.
 *
 * ★ The UI no longer renders one input box per entry — runtime configuration is a single
 *   JSON text area, and this table sits next to it as the manual (which keys exist, what
 *   ranges they take, what the defaults are, whether a key affects cost or safety). A JSON
 *   box carries no labels, so without this table users are left guessing key names.
 *
 * 每种 CLI 能配什么，由平台统一定义。
 *
 * ★ 界面不再按它逐项渲染输入框 —— 运行时配置是一个 JSON 文本框，这张表
 *   在旁边充当说明书（能配什么键、取值范围、默认值、影响成本还是安全）。
 *   JSON 框里没有标签，没有这张表用户就只能猜键名。
 */
/**
 * Capability catalog — the UI renders the ceiling checkboxes from it and shows the
 * **consequence** of each entry.
 *
 * ★ The frontend deliberately keeps no second copy: a copy means the platform can add a
 *   capability that never shows up in the UI, and "there is no such row in the UI" reads
 *   to a user as "this feature does not exist".
 *
 * 能力目录 —— 界面照着它渲染上限勾选，并显示每一条的**后果**。
 *
 * ★ 前端不再抄一份：抄一份的代价是平台加了一条能力而界面上没有，
 *   而「界面上没有这一栏」在用户那边等于「这个功能不存在」。
 */
export function listCapabilityCatalog() {
  return {
    capabilities: AGENT_CAPABILITIES.map((key) => ({
      key,
      label: CAPABILITY_SPECS[key].label,
      labelEn: CAPABILITY_SPECS[key].labelEn,
      consequence: CAPABILITY_SPECS[key].consequence,
      consequenceEn: CAPABILITY_SPECS[key].consequenceEn,
      risk: CAPABILITY_SPECS[key].risk,
      /** Platform floor: cannot be checked in the UI, and cannot be stored either */
      neverAutoGrant: CAPABILITY_SPECS[key].neverAutoGrant === true,
    })),
  };
}

export function listRuntimeCatalog() {
  return {
    kinds: RUNTIME_KIND_SPECS,
    /**
     * ★ Whether inline secrets are stored **encrypted**.
     *
     *   Note this is not "can they be stored at all": with no master key configured they
     *   still save fine, just in plaintext. The UI uses this to warn, not to disable the
     *   input — a safety measure that locks ordinary configuration out of the product only
     *   buys you users who route around this page.
     *
     * ★ 内联的敏感值是不是**密文**入库。
     *
     *   注意它不是「能不能存」：没配主密钥照样存得下，只是明文进库。
     *   界面据此提示，而不是据此禁用输入 —— 一个把常规配置挡在门外的
     *   安全措施，最后换来的是用户绕开这一页。
     */
    encryptsInlineSecrets: hasMasterKey(),
    credentialHelp:
      '推荐填 `env:变量名`：凭证只留在进程环境、不进数据库，多个 Agent 共用同一变量名时轮换只需改一处。' +
      '直接粘贴也可以：配了 APOS_SECRET_KEY 就密文进库、钥匙在库外，没配则明文进库（接口一律不回显）。',
  };
}

// ── Agent CRUD ────────────────────────────────────────────────────────

export const AgentInput = z.object({
  name: z.string().min(1, 'Agent 名称不能为空').max(80),
  type: z.string().min(1),
  description: z.string().nullable().optional(),

  /** Headless CLI kind */
  runtimeKind: z.string().min(1, '必须选择运行时类型'),
  /**
   * Configuration for that CLI — a free-form JSON document.
   *
   * ★ Keys the platform knows are validated against RUNTIME_KIND_SPECS; every other key is
   *   accepted and stored verbatim (the caller gets an `unknownConfigKeys` list back).
   *   Runtimes ship faster than this platform does, so rejecting unrecognized keys would
   *   make every runtime upgrade wait on a platform release.
   *
   * 该 CLI 的配置，一份自定义 JSON。
   *
   * ★ 平台认识的键按 RUNTIME_KIND_SPECS 校验，其余键原样收下、原样入库
   *   （回给调用方一份 unknownConfigKeys）。运行时升级得比平台快，
   *   把不认识的键拒掉等于让每次升级都先等平台发版。
   */
  runtimeConfig: z.record(z.unknown()).optional(),
  endpoint: z.string().url('接入地址必须是合法 URL').nullable().optional(),
  /** Plaintext credential or `env:VAR_NAME`. Omitted = unchanged; null = cleared */
  credential: z.string().nullable().optional(),

  model: z.string().nullable().optional(),

  /**
   * ★★ The **capability ceiling** the organization sets for this agent.
   *
   *   This layer answers "how far can this agent ever be authorized", not "what can it do
   *   right now" — the latter is a project-level matter (project_agent_permissions), and
   *   the same agent can carry two different answers in two projects.
   *
   * ★ `null` / omitted = no ceiling (fall back to the platform baseline), which is **not**
   *   the same as "grant nothing". The two mean opposite things: an empty array leaves this
   *   agent unable to do any work in any project.
   *
   * ★★ 组织给这个 Agent 定的**能力上限**。
   *
   *   这一层回答的是「这个 Agent 最多能被授权到什么程度」，
   *   而不是「它现在能做什么」—— 后者是项目级的事
   *   （project_agent_permissions），同一个 Agent 在两个项目里可以不一样。
   *
   * ★ `null` / 不传 = 不设上限（沿用平台基线），**不是**「一条都不给」。
   *   两者含义相反：空数组会让这个 Agent 在所有项目里都干不了活。
   */
  capabilityCeiling: z.array(AgentCapability).nullable().optional(),
  /** Organization-level hard denial: no project grant can override it */
  deniedCapabilities: z.array(AgentCapability).default([]),

  maxConcurrency: z.number().int().positive().max(50).default(3),
  timeoutSeconds: z.number().int().positive().max(86_400).default(1800),
  tokenLimitPerRun: z.number().int().positive().nullable().optional(),
  tokenLimitDaily: z.number().int().positive().nullable().optional(),

  /** ★ Never nullable: the accountability chain must not break when something goes wrong */
  ownerId: z.string().uuid('必须指定负责人'),
});
export type AgentInput = z.infer<typeof AgentInput>;

/**
 * What creating an Agent asks for / 建一个 Agent 要填的东西。
 *
 * ★★ 它比 {@link AgentInput} **少四栏**：skills、applicableTypes、
 *   capabilityCeiling、deniedCapabilities。
 *
 *   前两栏整个删掉了（承接范围由调度与绑定决定，专长标签不再存在）；
 *   后两栏是「事后限制」，不是「先回答才能开始」的问题 —— 建 Agent 时
 *   问「它最多能被授权到什么程度」，等于要求用户在还没跑过一次任务的时候
 *   就预判它会用到哪些能力。答不上来的人会跳过，而跳过的默认值是空数组，
 *   空数组的含义恰好是最坏的那一种。现在建出来就是全项目访问，
 *   要收窄去详情页的 Restrict access（走 PATCH，与这份 schema 是两回事）。
 *
 * Creation asks for a runtime connection and nothing else. The ceiling fields
 * live on update only: asking for a permission boundary before the agent has
 * ever run is asking users to predict what they cannot know, and the answer
 * people give when they cannot answer is "skip" — whose stored value was an
 * empty array, i.e. the worst of the available meanings.
 */
/**
 * 收下一栏只为了**当场拒掉**它。
 *
 * ★★ 默认丢弃比报错更糟。zod 的对象 schema 会静默丢掉多余的键 —— 一个还在
 *   送 `capabilityCeiling` 的老客户端会拿到 201，以为限制生效了，而实际建出来
 *   的是全项目访问。「配置没生效，而且没有任何迹象」是这个仓库反复吃过亏的
 *   那一类问题，所以这里宁可返回一个说得清下一步的 400。
 */
const refusedAtCreate = (field: string, hint: string) =>
  z
    .any()
    .refine((v) => v === undefined, {
      message: `创建 Agent 不再接收 ${field}：新建的 Agent 默认是全项目访问。${hint}`,
    })
    /**
     * ★ `.optional()` 必须在 `.refine()` **之后**。反过来的话，refine 包出来的
     *   ZodEffects 不再被 zod 认作可选，于是这一栏变成**必填** —— 表现是每一次
     *   建 Agent 都 400，而错误说的是「缺少 capabilityCeiling」。
     */
    .optional();

export const AgentCreateInput = AgentInput.omit({
  capabilityCeiling: true,
  deniedCapabilities: true,
}).extend({
  capabilityCeiling: refusedAtCreate(
    'capabilityCeiling',
    '要收窄请先建出来，再到 Agent 详情的「限制访问范围」里改（PATCH /admin/agents/:id）。',
  ),
  deniedCapabilities: refusedAtCreate(
    'deniedCapabilities',
    '硬拒绝同样在建完之后配（PATCH /admin/agents/:id）。',
  ),
  /**
   * ★★ 在哪个项目里建的。给了就把这个 Agent 加进那个项目。
   *
   *   在项目配置页建 Agent 却还要用户再去「成员与角色」加一次，是这套流程里
   *   最没有信息量的一步：用户刚刚在这个项目里点了「新建 Agent」，
   *   意图不可能更清楚了。而漏掉那一步的表现是 Agent 建好了、看着一切正常、
   *   就是永远派不到活（调度器判 `not_project_member`）。
   *
   * ★ 反过来，从组织级 Agent 页建的（不传 projectId）**不自动加进任何项目**：
   *   自动加进「所有项目」等于把每个项目的代码交给一个没人授权过它的执行体。
   *   默认全访问的边界始终是「当前这一个项目」。
   */
  projectId: z.string().uuid().nullable().optional(),
});
export type AgentCreateInput = z.infer<typeof AgentCreateInput>;

export async function createAgent(
  db: Database,
  registry: RuntimeRegistry,
  orgId: string,
  input: AgentCreateInput,
  actorUserId: string,
) {
  const spec = assertKind(input.runtimeKind);
  await assertOwner(db, input.ownerId);
  if (input.projectId) await assertProject(db, orgId, input.projectId);

  const { config, unknownKeys } = prepareConfig(input.runtimeKind, input.runtimeConfig, null);

  const credential = input.credential?.trim() || null;
  if (spec.credential && !credential && !credentialGivenInEnv(config)) {
    throw fail(
      'VALIDATION_FAILED',
      'agent.runtime_needs_credential',
      `${spec.label} 需要凭证（${spec.credential.label}）。可填 \`env:变量名\` 让凭证留在进程环境里，` + '或在运行时配置的环境变量表里直接给出对应的变量。',
      { params: { kind: spec.kind } },
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
      /**
       * ★★ 建的时候**不设上限、不硬拒绝**。
       *
       *   `null` 与空数组在这里含义相反：null 是「不设上限，沿用平台基线」，
       *   空数组是「一条能力都不给」。零配置的语义是前者 —— 实际能做什么由
       *   项目里的默认档案（full_project）决定，而平台基线那两条
       *   （permission.manage / policy.manage）任何配置都放不开。
       */
      capabilityCeiling: null,
      deniedCapabilities: [],
      maxConcurrency: input.maxConcurrency,
      timeoutSeconds: input.timeoutSeconds,
      tokenLimitPerRun: input.tokenLimitPerRun ?? null,
      tokenLimitDaily: input.tokenLimitDaily ?? null,
      ownerId: input.ownerId,
      status: 'active',
    })
    .returning();

  // ★ Register immediately instead of waiting for the next sync round — otherwise a
  //   freshly created agent is invisible for 15 seconds, the user reads that as "I created
  //   it and it does nothing", and all the UI says is "no adapter registered in this process"
  registerAgentNow(registry, row!);

  /**
   * ★★ 在项目里建的 Agent 当场入项目，不留一步给用户去别处补。
   *
   *   `onConflictDoNothing` 是必要的：这条路径没有幂等键兜着，重复提交
   *   （或者一个刚被移出项目又被重新建的同名 Agent）不该炸在唯一约束上。
   */
  let joinedProject = false;
  if (input.projectId) {
    await db
      .insert(projectMembers)
      .values({
        orgId,
        projectId: input.projectId,
        actorType: 'agent',
        actorId: row!.id,
        /**
         * ★ Agent 进项目拿的是 executor 角色 —— 它能干活，但拿不到人类那几档
         *   （批准、改角色、发 Policy）。这是「平台固定边界」的一半，
         *   另一半是能力目录里的 neverAutoGrant。
         */
        role: 'executor',
      })
      .onConflictDoNothing();
    joinedProject = true;
  }

  // Creating the profile is itself a permission grant, so it leaves an audit trail too
  await db.insert(agentPermissionChanges).values({
    agentId: row!.id,
    changedBy: actorUserId,
    direction: 'grant',
    before: { capabilityCeiling: [], deniedCapabilities: [] },
    after: ceilingOf(row!),
    reason: '创建 Agent',
  });

  return {
    agent: await describeAgent(db, registry, row!),
    unknownConfigKeys: unknownKeys,
    /** ★ 回给界面：它据此决定要不要提示「已加入本项目，可以直接派活」 */
    joinedProject,
  };
}

/**
 * Load one agent by id, **and** require that it belongs to the caller's organization.
 *
 * ★★ `/api/v1/admin/…` matches neither of rbac's two scope patterns (PROJECT_SCOPED_URL /
 *   RESOURCE_SCOPED_URL), so the gate can decide "is the caller entitled **within their own
 *   organization**" but not "whose agent is this" — and `ownsAgent` only compares ownerId,
 *   which likewise ignores the organization.
 *
 *   An agent carries a credential reference and resource scopes, so editing one across the
 *   tenant boundary means editing somebody else's execution subject: swapping allowedTools
 *   or pointing resourceScopes at your own repository leaves no anomaly on their side at
 *   all. That makes this narrowing even more important than the repository one.
 *
 * ★ Out-of-tenant access returns 404, not 403 — a 403 confirms that this id exists.
 *
 * 按 id 取一个 Agent，**并且**要求它属于调用者的组织。
 *
 * ★★ `/api/v1/admin/…` 不在 rbac 的两条作用域正则里
 *   （PROJECT_SCOPED_URL / RESOURCE_SCOPED_URL），闸门判得了
 *   「调用者在**自己组织**里够不够格」，判不了「这个 Agent 是谁的」——
 *   `ownsAgent` 比的也只是 ownerId，同样不看组织。
 *
 *   Agent 身上挂着凭证引用与资源范围，越界改一个 Agent 等于改别人的
 *   执行主体：换掉 allowedTools、把 resourceScopes 指向自己的仓库，
 *   都不会在对方那边留下任何异常。所以这道收窄比仓库那边更要紧。
 *
 * ★ 越界回 404 不回 403 —— 403 等于确认这个 id 存在。
 */
async function loadOwnedAgent(db: Database, orgId: string, agentId: string) {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (!row) throw notFound('agent');
  return row;
}

export async function updateAgent(
  db: Database,
  registry: RuntimeRegistry,
  orgId: string,
  agentId: string,
  input: Partial<AgentInput> & { reason?: string },
  actorUserId: string,
  /**
   * Callback that asserts the permission implied by the change's direction (09-security §2.3).
   *
   * ★ Widening needs tech_lead, narrowing only needs the owner — and the direction is only
   *   known after comparing the old and new permissions, so the route layer can only stop
   *   people who are not entitled to edit the profile at all. Same treatment as savePolicy.
   *
   * 权限方向判定回调（09-security §2.3）。
   *
   * ★ 扩大要 tech_lead、收紧只要 owner —— 而方向要把新旧权限比过才知道，
   *   路由层只挡得住「连改档案都不够格」的人。同 savePolicy 的处理。
   */
  assertCan?: (permission: 'agent.permissions.expand' | 'agent.permissions.restrict') => void,
) {
  const existing = await loadOwnedAgent(db, orgId, agentId);

  const kind = input.runtimeKind ?? existing.runtimeKind;
  if (input.runtimeKind) assertKind(input.runtimeKind);
  if (input.ownerId) await assertOwner(db, input.ownerId);

  const merged: AgentCeilingRecord = {
    capabilityCeiling:
      input.capabilityCeiling !== undefined
        ? input.capabilityCeiling
        : (existing.capabilityCeiling as AgentCapability[] | null),
    deniedCapabilities: input.deniedCapabilities ?? (existing.deniedCapabilities as AgentCapability[]),
  };
  assertCeilingSane(merged);

  const before = ceilingOf(existing);
  const permissionsChanged = JSON.stringify(before) !== JSON.stringify(merged);

  /**
   * ★ Widening permissions requires a reason; narrowing does not. The default explanation
   *   for narrowing ("let's be more careful") is almost always right, while the default
   *   explanation for widening ("they probably needed it") is almost never good enough.
   *
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
    throw fail('VALIDATION_FAILED', 'agent.widen_needs_reason', '放宽 Agent 权限必须填写原因');
  }

  /**
   * ★ Switching the CLI kind means re-validating the configuration: parameters from the old
   *   kind are usually invalid under the new one, and carrying them over verbatim shows a
   *   healthy-looking configuration in the UI while dispatch hands the CLI a pile of flags
   *   it does not recognize.
   *
   * ★ When the kind changes we also pass no previous config to `prepareConfig`: the whole
   *   configuration starts over, so a `secret://saved` placeholder has no old value behind
   *   it and must fail loudly here — rather than silently picking up a same-named value out
   *   of the *previous* CLI's environment-variable table.
   *
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
      ...(input.capabilityCeiling !== undefined
        ? { capabilityCeiling: input.capabilityCeiling }
        : {}),
      ...(input.deniedCapabilities ? { deniedCapabilities: input.deniedCapabilities } : {}),
      ...(input.maxConcurrency ? { maxConcurrency: input.maxConcurrency } : {}),
      ...(input.timeoutSeconds ? { timeoutSeconds: input.timeoutSeconds } : {}),
      ...(input.tokenLimitPerRun !== undefined
        ? { tokenLimitPerRun: input.tokenLimitPerRun ?? null }
        : {}),
      ...(input.tokenLimitDaily !== undefined
        ? { tokenLimitDaily: input.tokenLimitDaily ?? null }
        : {}),
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agentId))
    .returning();

  /**
   * ★ The registry instance must be **replaced**, never left alone. The old instance still
   *   holds the old effort and the old credential — skip this and the UI reports the edit as
   *   applied while the next dispatch still runs on the previous values.
   *
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
    unknownConfigKeys: prepared?.unknownKeys ?? [],
  };
}

export async function deleteAgent(db: Database, orgId: string, agentId: string) {
  // Called purely for the "exists and belongs to this organization" check — both a missing
  // id and a cross-tenant one turn into a 404 right here
  await loadOwnedAgent(db, orgId, agentId);

  const [active] = await db
    .select({ n: count() })
    .from(agentRuns)
    .where(and(eq(agentRuns.agentId, agentId), inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES])));

  if ((active?.n ?? 0) > 0) {
    throw fail(
      'VERSION_CONFLICT',
      'agent.has_active_runs',
      `该 Agent 还有 ${active!.n} 个执行中的 Run，无法删除`,
      { params: { count: active!.n }, details: { activeRuns: active!.n, } },
    );
  }

  /**
   * ★★ What follows counts **every foreign key pointing at agents.id**, not "the places
   *   that probably matter".
   *
   *   A missed one does not degrade gracefully into a missed check: it becomes a raw 23503,
   *   a code that is not in CLIENT_INPUT_PG_CODES, so clicking "delete agent" gets the user
   *   an "internal server error" with nothing naming what actually blocked the delete. This
   *   bug shipped twice — project role bindings and planning runs both point at agents.id,
   *   while this function only counted work items and requirements.
   *
   *   ★ Historical runs are counted **straight from agent_runs**, never inferred from "some
   *     work item names it as executor": planning runs have no work item at all
   *     (work_item_id is nullable), and reassigning a finished work item to another executor
   *     hides its runs from that proxy — in both cases the agent_runs rows are still there.
   *
   *   ★★ 这几项清点的是**指向 agents.id 的每一条外键**，不是「大概哪些地方用得上」。
   *
   *   漏掉一条的表现不是漏检，而是 23503 —— 那个码不在 CLIENT_INPUT_PG_CODES
   *   里，用户点「删除 Agent」得到的是一句「服务器内部错误」，看不出真正拦住
   *   它的是什么。这个 bug 出现过两次：项目角色绑定与规划 Run 都指着 agents.id，
   *   而这里只数了工作项与需求。
   *
   *   ★ 历史 Run 要**直接数 agent_runs**，不能拿「工作项的执行者是它」当代理指标：
   *     规划 Run 根本没有工作项（work_item_id 可空），而执行完的工作项换个执行者
   *     就再也数不到那些 Run —— 两种情况下 agent_runs 里的行都还在。
   */
  const [runs] = await db
    .select({ n: count() })
    .from(agentRuns)
    .where(eq(agentRuns.agentId, agentId));

  const [assigned] = await db
    .select({ n: count() })
    .from(workItems)
    .where(and(eq(workItems.executorType, 'agent'), eq(workItems.executorId, agentId)));

  /**
   * ★★ An agent named as some requirement's PRD author is likewise retired, not deleted.
   *
   *   Retiring beats nulling the reference out: clearing it silently undoes a choice
   *   somebody made, and the next time they open that requirement all they see is
   *   "unassigned", with no trace that anything happened. Once retired, the requirement page
   *   says plainly that the agent is retired and the next analysis run will fail.
   *
   * ★★ 被某条需求指定为 PRD 编写者的 Agent 同样只停用不删除。
   *
   *   停用而不是把引用清空：清空等于替用户撤销了他做过的指定，
   *   而他下一次进那条需求只会看到「未指定」，没有任何迹象说明发生过什么。
   *   停用之后需求页会明说「当前是 retired，下一次分析会失败」。
   */
  const [authoring] = await db
    .select({ n: count() })
    .from(requirements)
    .where(eq(requirements.authorAgentId, agentId));

  /**
   * ★★ Project role bindings also retire rather than delete, but for a different reason
   *   than the one above: a binding is **current configuration**, not history. Dropping it
   *   on the user's behalf breaks the next planning run on "no planner assigned", with
   *   nothing on the scene showing who emptied that slot. Retiring is a state the binding
   *   table was designed to fall back from (the fallback priority exists exactly for it), so
   *   once the user reads the reason they can rebind and then come back and delete.
   *
   * ★★ 项目角色绑定同样只停用不删除，理由和上面那条不一样：
   *   绑定是**当前配置**而不是历史，替用户把它删掉，下一次规划会在
   *   「planner 没人」上失败，而现场没有任何迹象说明那一格是被谁清掉的。
   *   停用是绑定表设计时就预留的状态（备选优先级正是为它准备的），
   *   用户看到 reason 之后可以去改绑，再回来删。
   */
  const [bound] = await db
    .select({ n: count() })
    .from(projectAgentBindings)
    .where(eq(projectAgentBindings.agentId, agentId));

  /**
   * ★ An agent with execution history is retired, never deleted. Delete it and the "who did
   *   this" on those runs and artifacts points at an id that no longer exists — the audit
   *   chain breaks exactly at the moment somebody needs it most.
   *
   * ★ 有历史执行记录的 Agent 只停用不删除。
   *   删掉的话，那些 Run 与产物的「谁做的」会指向一个不存在的 id ——
   *   审计链断在这里，而这正是最需要它的时候。
   */
  const reasons: string[] = [];
  if ((runs?.n ?? 0) > 0 || (assigned?.n ?? 0) > 0) {
    reasons.push('该 Agent 有历史执行记录');
  }
  if ((authoring?.n ?? 0) > 0) {
    reasons.push(`有 ${authoring!.n} 条需求指定由它编写 PRD`);
  }
  if ((bound?.n ?? 0) > 0) {
    reasons.push(`仍有 ${bound!.n} 处项目角色绑定指向它，请先到项目的「Agent 绑定」里改绑`);
  }

  if (reasons.length > 0) {
    await db
      .update(agents)
      .set({
        status: 'retired',
        /**
         * ★ Store **which specific** references held it back, not a generic "retired
         *   (history preserved)". This column is the only explanation shown on the agent
         *   list and detail pages; write a generic sentence and a user coming back days
         *   later sees a retired agent with no way to learn what blocked the delete.
         *
         * ★ 存下**具体**是被什么牵连，而不是一句「已停用（保留历史记录）」。
         *   这一列在 Agent 列表与详情页上是唯一的解释；写成通用句子的话，
         *   用户过几天回来看到一个停用的 Agent，无从知道当初拦住删除的是什么。
         */
        pausedReason: `已停用：${reasons.join('；')}`,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));
    /**
     * ★ Spell out **every** blocker, not just the first one. Each kind implies a different
     *   next step: with execution history the user does nothing, when a requirement names
     *   the agent as its author they usually want to switch that requirement to another
     *   agent, and with a role binding they must rebind first. Report only one and the user
     *   fixes it, clicks delete again, and gets a second reason they never saw before.
     *
     * ★ 把牵连**逐条**说清，而不是只报第一条。每一种的下一步不一样：
     *   有历史执行记录时用户什么都不用做，被需求指定为编写者时他多半想去
     *   那条需求上换一个，还有绑定时则必须去改绑 —— 只报一条的话，用户改完
     *   再点一次删除，等来的是另一条他上一次没看到的理由。
     */
    return {
      ok: true as const,
      retired: true,
      reason: `${reasons.join('；')}，已停用而非删除`,
    };
  }

  await db.delete(agentPermissionChanges).where(eq(agentPermissionChanges.agentId, agentId));

  try {
    await db.delete(agents).where(eq(agents.id, agentId));
  } catch (err) {
    /**
     * ★★ Safety net for the day somebody adds another table pointing at agents.id and
     *   forgets to count it above.
     *
     *   Without this layer that omission surfaces as "click delete → internal server
     *   error" — a sentence that explains neither what happened nor what to do next. Here
     *   it lands on the same path as every other blocker: retire, and say it is still
     *   referenced.
     *
     *   The constraint name is not returned: it is table and column names, i.e. information
     *   disclosure (see errors.ts). To find out which table it was, read this exception in
     *   the server log.
     *
     * ★★ 兜底：将来有人新加一张指向 agents.id 的表，而忘了在上面清点。
     *
     *   没有这一层的话，那次遗漏的表现是「点删除 → 服务器内部错误」——
     *   一句既不说明发生了什么、也不告诉用户下一步的话。这里把它落到
     *   与其他牵连同一条路上：停用，并说明它还被引用着。
     *
     *   不回传约束名：那是表名列名，属于信息泄露（见 errors.ts）。要定位
     *   到具体是哪张表，看服务端日志里这条异常。
     */
    if ((err as { code?: string }).code !== '23503') throw err;
    console.warn(
      `[agent-admin] 删除 Agent ${agentId} 撞上未清点的外键：${
        (err as { constraint_name?: string }).constraint_name ?? '未知约束'
      } —— 请把这张表加进 deleteAgent 的清点里`,
    );
    await db
      .update(agents)
      .set({ status: 'retired', pausedReason: '已停用（仍被引用）', updatedAt: new Date() })
      .where(eq(agents.id, agentId));
    return {
      ok: true as const,
      retired: true,
      reason: '该 Agent 仍被其他记录引用，已停用而非删除',
    };
  }

  return { ok: true as const, retired: false, reason: null };
}

/**
 * Capability probe.
 *
 * ★ "No adapter registered", "registered but unreachable" and "reachable but missing
 *   capabilities" are three different things, and the page has to show them separately.
 *   Collapse them into one "unavailable" and the user cannot tell whether to install a
 *   dependency, swap a key, or pick a different agent for the high-risk task.
 *
 * 能力探测。
 *
 * ★ 「适配器没注册」「注册了但连不上」「连上了但缺能力」是三件不同的事，
 *   页面必须分别显示 —— 混成一句「不可用」，用户不知道该去装依赖、
 *   换 key，还是换个 Agent 跑高风险任务。
 */
export async function probeAgent(
  db: Database,
  registry: RuntimeRegistry,
  orgId: string,
  agentId: string,
) {
  const row = await loadOwnedAgent(db, orgId, agentId);

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
     * ★ "Who is using this credential". Once the connection layer was removed, that question
     *   lost its natural home — aggregating by credentialRef puts it back, so before rotating
     *   a key you can see at a glance how many agents it touches.
     *
     * ★ 「这把凭证被谁在用」。取消接入层之后，这个问题失去了天然的答案位置 ——
     *   靠 credentialRef 聚合把它补回来，轮换前能一眼看到要动几个 Agent。
     */
    credentialUsage: usageByCredential(rows),
    ...listRuntimeCatalog(),
  };
}

/**
 * Aggregate by credential reference. Agents sharing an `env:` reference collapse into one
 * row, since rotating them means editing that single environment variable.
 */
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
    /** `env:` rotates in one place; inline secrets have to be re-entered agent by agent */
    rotationCost: e.kind === 'env' ? 'one_place' : `${e.agents.length}_places`,
  }));
}

async function describeAgent(db: Database, registry: RuntimeRegistry, row: AgentRow) {
  const cred = describeRef(row.credentialRef);
  const spec = runtimeKindSpec(row.runtimeKind);

  let capability: ReturnType<typeof buildCapability> | null = null;
  let reachable = false;
  let problem: string | null = null;
  /** ★ The code paired with `problem`. The UI reads the code, logs read the sentence */
  let problemCode: 'probe_failed' | 'no_adapter' | null = null;

  if (registry.has(row.id)) {
    try {
      capability = buildCapability(await registry.get(row.id).getCapabilities());
      reachable = true;
    } catch (err) {
      problem = err instanceof Error ? err.message : '能力探测失败';
      problemCode = 'probe_failed';
    }
  } else {
    problem = `本进程没有 ${row.runtimeKind} 的适配器实现，任务派不出去`;
    problemCode = 'no_adapter';
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
    /**
     * ★ Encrypted values in the env table come back as a placeholder only — same discipline
     *   as the credential column
     */
    runtimeConfig: maskRuntimeConfig(row.runtimeConfig),
    /**
     * ★ References in the env table that resolve to nothing. Same class of problem as
     *   credentialProblem: the configuration looks healthy, it blows up at dispatch time,
     *   and the error never points at "that environment variable is not set".
     *
     * ★ 环境变量表里那些取不到值的引用。
     *   和 credentialProblem 是同一类问题：配置看着完好，派发时才炸，
     *   而报错不会指向「那个环境变量没设置」。
     */
    runtimeConfigProblems: describeEnvOverrides(envOverridesOf(row.runtimeConfig)),
    problemCode,
    problemParams: problemCode === 'no_adapter' ? { kind: row.runtimeKind } : undefined,
    endpoint: row.endpoint,

    /** ★ Only the hint and a usability verdict — never the raw value */
    credentialHint: row.credentialHint,
    credentialUsable: cred.usable,
    credentialKind: cred.kind,
    credentialProblem: cred.problem,
    /** ★ The code paired with the Chinese sentence above; the UI looks up its message by it */
    credentialProblemCode: cred.problemCode,
    credentialProblemParams: cred.problemParams,

    registered: registry.has(row.id),
    reachable,
    problem,
    lastCheckAt: row.lastCheckAt?.toISOString() ?? null,

    model: row.model,
    /**
     * ★ The organization-level record returns the **ceiling** only, never "what it can do".
     *   That is a project-level question, and the same agent can have two different answers
     *   in two projects — putting a single number on this page means publishing an answer
     *   that is wrong in every concrete project.
     *
     * ★ 组织级记录只回**上限**，不回「它能做什么」。
     *   后者是项目级的问题，同一个 Agent 在两个项目里可以是两套答案 ——
     *   在这一页给一个数字，等于给一个在任何具体项目里都不准的答案。
     */
    ceiling: ceilingOf(row),
    maxConcurrency: row.maxConcurrency,
    timeoutSeconds: row.timeoutSeconds,
    tokenLimitPerRun: row.tokenLimitPerRun,
    tokenLimitDaily: row.tokenLimitDaily,

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

// ── Validation ────────────────────────────────────────────────────────

function assertKind(kind: string) {
  if (!isKnownRuntimeKind(kind)) {
    throw fail(
      'VALIDATION_FAILED',
      'agent.unsupported_runtime_kind',
      `不支持的运行时类型：${kind}`,
      { params: { kind }, details: { supported: RUNTIME_KIND_SPECS.map((k) => k.kind), } },
    );
  }
  return runtimeKindSpec(kind)!;
}

/**
 * Validate a runtime configuration and replace sensitive values in the env table with
 * references.
 *
 * 校验运行时配置，并把环境变量表里的敏感值换成引用。
 *
 * @param previous The configuration already stored, used to redeem `secret://saved`
 *   placeholders. Pass null when creating.
 */
function prepareConfig(
  kind: string,
  input: Record<string, unknown> | undefined,
  previous: Record<string, unknown> | null,
): { config: Record<string, unknown>; unknownKeys: string[] } {
  const result = validateRuntimeConfig(kind, input);
  if (!result.ok) {
    /**
     * ★ Reject at save time rather than letting it through. Letting it through looks like a
     *   successful dispatch followed by a parameter error the CLI prints at startup and
     *   nobody reads — while the UI keeps showing this agent as correctly configured.
     *
     * ★ 在保存这一刻拒掉，而不是放行。
     *   放行的表现是派发成功、CLI 启动时报一句没人看的参数错误，
     *   而界面上这个 Agent 显示为配置完好。
     */
    throw fail(
      'VALIDATION_FAILED',
      'agent.invalid_runtime_config',
      `运行时配置不合法：${result.issues[0]!.message}`,
      { details: { issues: result.issues, } },
    );
  }

  // When the runtime has no env table at all (mock, for instance), do not invent an `env` key
  if (!('env' in result.config)) return { config: result.config, unknownKeys: result.unknownKeys };

  try {
    return {
      config: {
        ...result.config,
        env: encodeEnvOverrides(envOverridesOf(result.config), envOverridesOf(previous)),
      },
      unknownKeys: result.unknownKeys,
    };
  } catch (err) {
    if (err instanceof SecretConfigError) throw fail(
      'VALIDATION_FAILED',
      err.reason,
      err.message,
      { params: err.params },
    );
    throw err;
  }
}

/** For read-back: encrypted values in the env table become placeholders, never plaintext */
function maskRuntimeConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (!('env' in config)) return config;
  return { ...config, env: maskEnvOverrides(envOverridesOf(config)) };
}

/**
 * Whether the env table already supplies a credential.
 *
 * ★ This is only a coarse screen for "don't let someone save an agent that obviously cannot
 *   run": we do not know which variable name each CLI reads, so we go by "is there a key
 *   shaped like a secret". The real decision lives in the adapter's dispatch — it knows what
 *   it reads, and it is the only place that can actually stop the run.
 *
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
    if (err instanceof SecretConfigError) throw fail(
      'VALIDATION_FAILED',
      err.reason,
      err.message,
      { params: err.params },
    );
    throw err;
  }
}

async function assertOwner(db: Database, ownerId: string) {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, ownerId));
  if (!u) throw notFound('owner');
}

/**
 * ★★ 「在这个项目里建」的项目必须属于调用者的组织。
 *
 *   不查组织的话，一个跨租户的 projectId 会让这个 Agent 悄悄成为别人项目的
 *   成员 —— 而项目成员关系正是调度器唯一的授权判据。越界回 404 不回 403：
 *   403 等于确认这个 id 存在。
 */
async function assertProject(db: Database, orgId: string, projectId: string) {
  const [p] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)));
  if (!p) throw notFound('project');
}

export interface AgentCeilingRecord {
  capabilityCeiling: AgentCapability[] | null;
  deniedCapabilities: AgentCapability[];
}

/**
 * Sanity check on the capability ceiling.
 *
 * ★ The same capability appearing in both the ceiling and the hard denial list is two
 *   contradictory statements in one configuration. Say nothing and the UI shows that
 *   capability as granted while it can never actually be obtained — and the investigation
 *   runs all the way from project grants down to the runtime before anyone notices.
 *
 * ★ The empty-array/null distinction has to hold here too: an empty array means "grant
 *   nothing", which leaves this agent unable to do work in any project. That deserves to be
 *   said at save time.
 *
 * 能力上限自检。
 *
 * ★ 同一条能力既在上限里又在硬拒绝里，是配置层面自相矛盾的两句话。
 *   不报错的话，界面上那条能力看起来是给了的，而实际永远拿不到 ——
 *   而排查会从项目授权一路查到运行时。
 *
 * ★ 空数组与 null 的区别在这里也要守住：空数组是「一条都不给」，
 *   它会让这个 Agent 在所有项目里都干不了活，值得当场说一句。
 */
function assertCeilingSane(c: AgentCeilingRecord) {
  const denied = new Set(c.deniedCapabilities);
  const conflict = (c.capabilityCeiling ?? []).filter((x) => denied.has(x));
  if (conflict.length > 0) {
    throw fail(
      'VALIDATION_FAILED',
      'agent.capability_in_ceiling_and_denial',
      `以下能力同时出现在上限与硬拒绝里：${conflict .map((x) => CAPABILITY_SPECS[x].label) .join('、')}。拒绝优先级更高，它们实际拿不到`,
      { params: { capabilities: conflict.join(', ') }, details: { conflict } },
    );
  }

  if (c.capabilityCeiling !== null && c.capabilityCeiling.length === 0) {
    throw fail(
      'VALIDATION_FAILED',
      'agent.empty_capability_ceiling',
      '能力上限是空的 —— 这个 Agent 在任何项目里都干不了活。不想设上限请留空（不传），而不是给一个空清单',
    );
  }
}

function ceilingOf(row: AgentRow): AgentCeilingRecord {
  return {
    capabilityCeiling: (row.capabilityCeiling as AgentCapability[] | null) ?? null,
    deniedCapabilities: row.deniedCapabilities as AgentCapability[],
  };
}

/**
 * Direction of a ceiling change: any side getting wider counts as a grant.
 *
 * ★★ The verdict comes from the same source as project-level grants (domain's
 *   capabilityChangeImpact). This one direction decides three things at once: whether a
 *   reason is required, how the change is recorded in the audit trail, and which permission
 *   tier is needed (the asymmetric design in §2.3). Three call sites with three separate
 *   verdicts guarantees that one of them eventually disagrees with the other two.
 *
 * ★ `null` (no ceiling) expands to **every capability** for the comparison: going from "no
 *   ceiling" to a concrete list is a narrowing, and the reverse is a widening. Compare it as
 *   an empty array instead and the direction comes out exactly backwards.
 *
 * 上限改动的方向：只要有任何一面变宽就算 grant。
 *
 * ★★ 判据与项目级授权同源（domain 的 capabilityChangeImpact）——
 *   这个方向同时决定三件事：要不要填原因、审计里怎么记、
 *   以及需要哪一档权限（§2.3 的不对称设计）。三处用三份判据的话，
 *   总有一处会和另外两处说的不一样。
 *
 * ★ `null`（不设上限）在比较时展开成**全部能力**：从「不设上限」改成
 *   一份具体清单是收紧，反过来是放宽。当成空数组比的话，方向正好判反。
 */
function directionOf(before: AgentCeilingRecord, after: AgentCeilingRecord): 'grant' | 'revoke' {
  const expand = (c: AgentCeilingRecord) => ({
    capabilities: c.capabilityCeiling ?? [...AGENT_CAPABILITIES],
    deniedCapabilities: c.deniedCapabilities,
    resourceScopes: [],
  });
  return capabilityChangeImpact(expand(before), expand(after)).direction === 'loosen'
    ? 'grant'
    : 'revoke';
}
