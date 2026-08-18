import type { AgentPermissions, ResourceScope } from '@apos/contracts';

/**
 * 写类工具。仓库资源范围没有 write 时整体禁用 ——
 * 只靠 Agent 自觉「不要改文件」不是权限控制。
 */
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

export interface MappedPermissions {
  /**
   * 进入模型上下文的基础工具集。
   *
   * ★ 只放已授权的工具 —— Agent 根本看不到没授予的工具，
   *   而不是「看得到但被拒绝」。少一轮无效尝试，也少一次越权机会。
   */
  tools: string[];
  /** 免确认放行的规则，可带作用域（如 `Bash(npm test:*)`） */
  allowedTools: string[];
  /** 黑名单。SDK 侧优先级高于白名单，与 AgentPermissions 的约定一致 */
  disallowedTools: string[];
  /** 主工作目录 */
  cwd: string | null;
  /** 额外可访问目录 */
  additionalDirectories: string[];
  /** 是否具备写权限 */
  writable: boolean;
  /** 非仓库类资源（数据库、外部服务），写进 prompt 让 Agent 知道边界 */
  otherScopes: ResourceScope[];
}

/** `Bash(npm test:*)` → `Bash` */
export function baseToolName(rule: string): string {
  const idx = rule.indexOf('(');
  return (idx === -1 ? rule : rule.slice(0, idx)).trim();
}

/** 无作用域的裸规则（`Bash`）才代表整个工具被禁；`Bash(rm *)` 只禁匹配的调用 */
function isBareRule(rule: string): boolean {
  return !rule.includes('(');
}

export interface WorkspaceResolver {
  (scope: ResourceScope): string | null;
}

/**
 * 把 APOS 的权限模型映射到 Agent SDK 的三个开关。
 *
 * 映射不是一一对应，关键在于组合出「默认拒绝」：
 * - tools        决定 Agent 能看到什么
 * - allowedTools 决定什么免确认放行
 * - 其余一律落到 canUseTool（见 adapter.ts），由适配器拒绝或升级为人工决策
 */
export function mapPermissions(
  permissions: AgentPermissions,
  resolveWorkspace: WorkspaceResolver,
): MappedPermissions {
  const denied = [...permissions.deniedTools];
  const deniedBare = new Set(denied.filter(isBareRule).map(baseToolName));

  const repoScopes = permissions.resourceScopes.filter((s) => s.kind === 'repo');
  const readable = repoScopes.filter((s) => s.access !== 'none');

  /**
   * ★ 与 acquire() 的主挂载规则对齐：repo 与 dataset 的 write 都算可写。
   *
   *   只认 repo 的话，被授了 dataset write 的 Agent 会挂上一个可写的工作区、
   *   写工具却全被禁 —— 平台说可写、适配器说不可写，两个子系统给出两个答案，
   *   现场表现是「授权界面写着 Write，Agent 说没有 Write 工具」。
   *
   *   readable/dirs 仍然只从 repo scope 来：目录解析要有平台背书，
   *   dataset 的路径经 task.workspace.additionalPaths 下发，混进来会让
   *   cwd 兜底逻辑产生一个没人准备过的路径。
   *
   * Align with acquire()'s primary-mount rule: a write scope on either a repo
   * or a dataset counts as writable. Repo-only left dataset-write agents with
   * a writable mount and no write tools — two subsystems, two answers.
   * Directory resolution stays repo-only; dataset paths arrive through
   * task.workspace.additionalPaths.
   */
  const writable = permissions.resourceScopes.some(
    (s) => s.access === 'write' && (s.kind === 'repo' || s.kind === 'dataset'),
  );

  if (!writable) {
    for (const t of WRITE_TOOLS) {
      if (!deniedBare.has(t)) {
        denied.push(t);
        deniedBare.add(t);
      }
    }
  }

  const tools = [...new Set(permissions.allowedTools.map(baseToolName))].filter(
    (t) => t.length > 0 && !deniedBare.has(t),
  );

  const dirs = readable
    .map(resolveWorkspace)
    .filter((d): d is string => typeof d === 'string' && d.length > 0);

  return {
    tools,
    allowedTools: permissions.allowedTools.filter((r) => !deniedBare.has(baseToolName(r))),
    disallowedTools: denied,
    cwd: dirs[0] ?? null,
    additionalDirectories: dirs.slice(1),
    writable,
    otherScopes: permissions.resourceScopes.filter(
      (s) => s.kind !== 'repo' && s.access !== 'none',
    ),
  };
}

/** 是否是写类工具的裸名 */
function isWriteTool(tool: string): boolean {
  return (WRITE_TOOLS as readonly string[]).includes(tool);
}

/**
 * 用平台已准备好的工作区，覆盖由资源范围推导出来的「可写」。
 *
 * ★★ 两个方向都覆盖，因为两个方向的错法都真实发生过：
 *
 *   - writable=true —— 规划 Run 的 scratch 目录**没有任何 scope 对应它**，
 *     scope 推导永远推不出可写，于是平台给了可写目录、Agent 却写不出产物。
 *     dataset 主挂载同理。
 *   - writable=false —— 只读挂载时显式收紧，兑现 RunWorkspace.writable
 *     那句「适配器据此再收一道写工具」的契约注释。
 *
 *   能力闸门不在这一层，也放不出它没授的东西：写工具是从
 *   `permissions.allowedTools` 里挑回来的，`workspace.write` 没授予时
 *   它们本来就不在里面。显式黑名单（deniedTools 里的裸条目）同样不放回来 ——
 *   黑名单优先级高于白名单是全系统的约定。
 *
 * The prepared workspace's truth overrides scope-derived writability in both
 * directions: planning scratch dirs have no scope at all (so scope inference
 * can never say "writable"), and a read-only mount must clamp write tools shut.
 * This cannot widen past the capability gate — restored tools are re-picked
 * from permissions.allowedTools, and explicit denies stay denied.
 */
export function applyWorkspaceWritable(
  base: MappedPermissions,
  permissions: AgentPermissions,
  writable: boolean,
): MappedPermissions {
  const explicitBare = new Set(
    permissions.deniedTools.filter(isBareRule).map(baseToolName),
  );

  // 先摘掉 mapPermissions 因 scope 推导而追加的写工具禁令，
  // 管理员/Policy 显式写下的那份原样留着
  const disallowedTools = base.disallowedTools.filter(
    (rule) =>
      !(
        isBareRule(rule) &&
        isWriteTool(baseToolName(rule)) &&
        !explicitBare.has(baseToolName(rule))
      ),
  );

  if (!writable) {
    const bare = new Set(disallowedTools.filter(isBareRule).map(baseToolName));
    for (const t of WRITE_TOOLS) {
      if (!bare.has(t)) {
        disallowedTools.push(t);
        bare.add(t);
      }
    }
  }

  const deniedBare = new Set(disallowedTools.filter(isBareRule).map(baseToolName));

  return {
    ...base,
    tools: [...new Set(permissions.allowedTools.map(baseToolName))].filter(
      (t) => t.length > 0 && !deniedBare.has(t),
    ),
    allowedTools: permissions.allowedTools.filter((r) => !deniedBare.has(baseToolName(r))),
    disallowedTools,
    writable,
  };
}

/** 该工具是否被黑名单显式禁止（用于区分「被 Policy 禁了」和「没授予」） */
export function isExplicitlyDenied(tool: string, permissions: AgentPermissions): boolean {
  return permissions.deniedTools.some((rule) => baseToolName(rule) === baseToolName(tool));
}
