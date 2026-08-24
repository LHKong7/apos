import { z } from 'zod';

/**
 * 服务端报错的结构化形态 —— 前后端共享 / Structured API error reasons.
 *
 * ★★ 为什么错误不能只是一句话：这句话有两个消费者 —— 中文界面和英文界面。
 *
 *   拼好的中文只服务第一种。英文界面拿到它只有两条路：原样显示（于是
 *   英文用户看到一屏中文），或者反过来正则匹配它再改写（而匹配一句
 *   随时会改的话是定时炸弹）。所以走**码 + 参数**，界面按码取词。
 *
 *   这是 `RejectionCode`（work-item/blocked.ts）与 `DecisionReason`
 *   （work-item/decision-reason.ts）已经在做的事，这里把它推广到所有
 *   HTTP 报错上 —— CLAUDE.md 里记的「若干校验报错仍是中文句子」那个缺口。
 *
 * ★ 中文句子**保留**在抛出点，作为 `message` 原样送出。
 *   界面读码，日志读句子：日志、告警、存量客户端仍然要一句现成的话，
 *   而给日志读一个 `storage.type_immutable` 等于让值班的人多查一张表。
 *
 *   The prose stays as `message` for logs and older clients; the UI reads the
 *   code. A code alone would make on-call staff look up a table at 3am.
 *
 * ★ 用户自己写的词（Policy 名、Agent 名、路径）作为 `params` 原样带过去，
 *   不翻译 —— 把用户起的名「翻译」一遍等于给它改名。
 */

/**
 * 「找不到」说的是**哪一种**东西。
 *
 * ★★ 不能拼 `${what}不存在`。中文里名词在前，英文里 "not found" 在后，
 *   拼出来的句子只在写它的那种语言里成立 —— 英文侧会得到
 *   「Artifactnot found」这种东西。所以整句是一条词条，实体名是它的键的一部分。
 *
 *   Never concatenate: the noun leads in Chinese and trails in English, so a
 *   sentence assembled from pieces can only be right in one of them.
 */
export const NotFoundEntity = z.enum([
  'project',
  'work_item',
  'parent_work_item',
  'agent',
  'integration',
  'requirement',
  'policy',
  'decision',
  'plan',
  'run',
  'user',
  'file',
  'project_convention',
  'conflict',
  'project_member',
  'owner',
  'role',
  'org_member',
  'organization',
  'template',
  'storage_target',
  'external_object_link',
  'repository',
  'artifact',
]);
export type NotFoundEntity = z.infer<typeof NotFoundEntity>;

/**
 * 报错原因码。命名是 `区域.说的是什么`，与词条键 `error.reason.<code>` 一一对应。
 *
 * ★ 扁平结构：`error.reason.storage.type_immutable` 这条键要能被 grep 到，
 *   而搜索是唯一能查清一句话用在哪儿的办法（同 en.ts 的约定）。
 */
export const ErrorReason = z.enum([
  /** 「找不到」。说的是哪种东西由 `entity` 带，见 NotFoundEntity */
  'not_found',

  // ── 身份与访问 / auth ────────────────────────────────────────────
  'auth.missing_token',
  'auth.bad_token_subject',
  'auth.account_gone',
  'auth.wrong_password',
  'auth.forbidden',
  'auth.wrong_org',
  'auth.run_token_invalid',

  // ── 幂等键 / idempotency ─────────────────────────────────────────
  'idempotency.key_too_long',
  'idempotency.key_taken_by_other_actor',

  // ── 组织与成员 / org & membership ────────────────────────────────
  'org.not_a_member',
  'org.cross_org_create',
  'member.human_role_required',
  'member.user_outside_org',

  // ── 任务与流转 / work item ───────────────────────────────────────
  'work_item.no_agent_specified',
  'work_item.takeover_needs_user',
  'work_item.dispatch_failed',
  'work_item.nudge_too_soon',

  // ── 决策 / decision ──────────────────────────────────────────────
  'decision.already_handled',
  'decision.not_delegable',

  // ── 计划与需求 / plan & requirement ──────────────────────────────
  'plan.approved_cannot_replan',

  // ── Agent 与权限 / agent ─────────────────────────────────────────
  'agent.runtime_not_registered',
  'agent.empty_capability_ceiling',
  'agent.widen_needs_reason',
  'agent.suspend_needs_reason',

  // ── 存储与交货 / storage ─────────────────────────────────────────
  'storage.type_immutable',
  'storage.object_store_needs_endpoint',
  'storage.object_store_needs_bucket',
  'storage.local_needs_absolute_path',
  'storage.path_must_be_absolute',
  'storage.path_outside_mount_roots',
  'storage.delivery_target_missing',
  'storage.delivery_target_self',

  // ── 产物文件网关 / artifact files ────────────────────────────────
  'artifact.no_local_archive',
  'artifact.path_escapes_root',
  'artifact.path_escapes_via_symlink',

  // ── 集成 / integration ───────────────────────────────────────────
  'integration.ci_needs_code_kind',
  'integration.notify_needs_collab_kind',
  'integration.channel_required',
  'integration.channels_unavailable',
  'integration.conflict_already_handled',
  'integration.sync_paused',

  // ── 请求本身 / request ───────────────────────────────────────────
  'request.invalid',
  'request.invalid_params',
  'request.bad_path_or_query',
  'request.param_too_long',
  'request.number_out_of_range',
  'request.bad_timestamp',
  'request.timestamp_out_of_range',
  'request.against_must_be_version',
  'request.bad_enum_value',

  // work_item
  'work_item.reassign_needs_run_disposition',

  // agent
  'agent.not_project_member',
  'agent.not_available',
  'agent.unknown_capability_profile',

  // user
  'user.not_project_member',

  // auth
  'auth.signup_rate_limited',
  'auth.signup_disabled',
  'auth.bad_credentials',
  'auth.email_already_registered',
  'auth.email_taken_use_add_member',

  // storage
  'storage.ref_taken',
  'storage.readonly_would_drop_deliveries',
  'storage.referenced_by_agents',
  'storage.referenced_by_deliveries',
  'storage.delivery_target_disabled',
  'storage.delivery_target_readonly',
  'storage.ref_taken_by_repository',

  // repository
  'repository.ref_taken',
  'repository.referenced_by_agents',
  'repository.ssh_key_unusable',

  // org
  'org.slug_taken',
  'org.has_projects',
  'org.last_one_for_you',
  'org.no_account_for_email',
  'org.last_admin',
  'org.slug_variants_exhausted',

  // request
  'request.no_such_endpoint',

  // policy
  'policy.loosening_contradicts_history',
  'policy.org_scoped_readonly',
  'policy.org_rule_cannot_be_loosened',
  'policy.has_pending_decisions',

  // agent
  'agent.runtime_needs_credential',
  'agent.has_active_runs',
  'agent.unsupported_runtime_kind',
  'agent.invalid_runtime_config',
  'agent.capability_in_ceiling_and_denial',
  'agent.change_needs_reason',

  // member
  'member.outside_org',
  'member.last_manager',
  'member.unknown_role',

  // role
  'role.key_taken',
  'role.builtin_permissions_locked',
  'role.builtin_undeletable',
  'role.agents_hold_it',
  'role.humans_hold_it',

  // project
  'project.not_visible',

  // policy
  'policy.org_rule_cannot_be_loosened_unnamed',

  // integration
  'integration.provider_already_connected',
  'integration.transport_not_implemented',
  'integration.connection_test_failed',
  'integration.forbidden_scopes',
  'integration.field_source_unsupported',
  'integration.work_item_already_linked',

  // requirement
  'requirement.confirmed_readonly',
  'requirement.has_derived_work',
  'requirement.confirmed_cannot_change_agent',
  'requirement.no_structured_content',
  'requirement.unanswered_must_confirm',

  // plan
  'plan.no_requirement',
  'plan.unassigned_human_tasks',
  'plan.over_budget',
  'plan.preflight_failed',
  'requirement.fallback_needs_manual_completion',

  // work_item
  'work_item.manual_status_not_allowed',
  'work_item.not_startable',
  'work_item.transition_not_allowed',

  // run
  'run.already_final',

  // runtime
  'runtime.action_unsupported',

  // work_item
  'work_item.workspace_unavailable',
  'work_item.human_executor',

  // secret
  'secret.empty_credential',
  'secret.bad_env_var_name',
  'secret.protected_env_key',
  'secret.no_previous_value',
  'secret.no_secret_uri',

  // auth
  'auth.password_too_short',
  'auth.password_too_long',
  'auth.token_malformed',
  'auth.token_bad_algorithm',
  'auth.token_bad_signature',
  'auth.token_no_subject',
  'auth.token_no_expiry',
  'auth.token_expired',

  // org
  'org.no_membership_yet',

  // role
  'role.human_only',
  'role.agent_only',
  'role.in_use_by_humans',
  'role.in_use_by_agents',
  'role.in_use_by_both',
  'role.invalid_permissions',

  // guard
  'guard.failed',

  // policy
  'policy.denied',

  // ── 兜底 / fallback ──────────────────────────────────────────────
  'internal',
]);
export type ErrorReason = z.infer<typeof ErrorReason>;

/**
 * 错误信封里 `details` 的**保留形状**。
 *
 * ★ `details` 原本就是自由字段，各处塞各自的上下文（`{ path }`、
 *   `{ artifactId }`）。这里只钉住 `code` / `params` 两个键的含义，
 *   其余照旧 —— 否则这次改造要重写每一处的 details。
 */
export interface ErrorDetail {
  /** 原因码。界面据此取词；认不出时回落到 `message` 那句话 */
  code?: ErrorReason;
  /** 词条里 `{name}` 的实参。用户自己写的词原样带，不翻译 */
  params?: Record<string, string | number>;
  /** 表单里该高亮哪个字段 */
  field?: string;
  /** 「找不到」时说的是哪种东西 */
  entity?: NotFoundEntity;
}
