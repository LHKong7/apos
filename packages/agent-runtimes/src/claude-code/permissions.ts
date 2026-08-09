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
  const writable = repoScopes.some((s) => s.access === 'write');

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

/** 该工具是否被黑名单显式禁止（用于区分「被 Policy 禁了」和「没授予」） */
export function isExplicitlyDenied(tool: string, permissions: AgentPermissions): boolean {
  return permissions.deniedTools.some((rule) => baseToolName(rule) === baseToolName(tool));
}
