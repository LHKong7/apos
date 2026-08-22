import type {
  AgentCapability,
  CapabilityDegradation,
  CapabilityTranslationInput,
  CapabilityTranslation,
  ResourceScope,
} from '@apos/contracts';

/**
 * 语义能力 → 工具名，共用的那一半。
 *
 * ★★ 用户不该再见到 `Read` / `Edit` / `Bash(npm test:*)` 这些词。
 *
 *   它们是运行时的词汇，而运行时是 Agent 的一个属性，不是用户要做的选择。
 *   在这张表出现之前，「让这个 Agent 能跑测试」的正确写法是
 *   `Bash(npm test:*)` —— 一个没有任何地方写着、猜不出来、而且换个运行时
 *   就不成立的字符串。猜不出来的配置项的真实默认值是「用户从别处抄来的那份」。
 *
 * ★ 一份基础映射 + 各运行时改写差异，而不是每个适配器抄一张表：
 *   抄出来的表会各自漂移，而漂移的方向永远是「某个适配器多给了一点」。
 *
 * The shared half of capability → tool translation. Users should never see
 * runtime tool names: they are the runtime's vocabulary, and the runtime is a
 * property of the Agent rather than a choice the user makes. One base table
 * that adapters narrow, not one table per adapter — copies drift, and they
 * drift toward granting more.
 */

/**
 * 受约束的命令规则。
 *
 * ★★ 给的是**带作用域**的 Bash 规则，不是裸 `Bash`。
 *
 *   裸 `Bash` 等于把整台机器交出去 —— 「能跑测试」和「能跑 rm -rf」
 *   在那之后没有任何区别。带作用域的规则只免确认匹配的那些调用，
 *   其余落到 canUseTool 上由适配器逐次判（见 claude-code/adapter.ts）。
 *
 * ★ 覆盖主流包管理器与语言，而不是只写 npm：写少了的表现不是报错，
 *   是 Agent 在一个 pnpm 仓库里反复被拦下、然后自己想别的办法绕过去。
 */
const TEST_COMMANDS = [
  'Bash(npm test:*)',
  'Bash(npm run test:*)',
  'Bash(pnpm test:*)',
  'Bash(pnpm run test:*)',
  'Bash(yarn test:*)',
  'Bash(go test:*)',
  'Bash(pytest:*)',
  'Bash(cargo test:*)',
  'Bash(make test:*)',
];

const BUILD_COMMANDS = [
  'Bash(npm run build:*)',
  'Bash(pnpm build:*)',
  'Bash(pnpm run build:*)',
  'Bash(yarn build:*)',
  'Bash(go build:*)',
  'Bash(cargo build:*)',
  'Bash(make:*)',
  'Bash(tsc:*)',
];

const PUSH_COMMANDS = ['Bash(git push:*)'];
const PR_CREATE_COMMANDS = ['Bash(gh pr create:*)', 'Bash(git push:*)'];
const PR_MERGE_COMMANDS = ['Bash(gh pr merge:*)'];

/**
 * 基础映射表。
 *
 * ★ 空数组不是「漏了」，是「这条能力没有对应工具」：
 *   `artifact.create` 走的是 Run 结果通道（适配器合成产物事件），
 *   `secret.read` 由凭证注入决定，不是一个工具调用。空数组必须是显式的 ——
 *   留空让人以为是漏配，而漏配和「本来就没有」的修法完全不同。
 */
export const CAPABILITY_TOOLS: Record<AgentCapability, readonly string[]> = {
  'workspace.read': ['Read', 'Grep', 'Glob'],
  'workspace.write': ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  'command.build': BUILD_COMMANDS,
  'command.test': TEST_COMMANDS,
  'network.external': ['WebFetch', 'WebSearch'],
  'artifact.create': [],
  'repository.push': PUSH_COMMANDS,
  'pull_request.create': PR_CREATE_COMMANDS,
  'pull_request.merge': PR_MERGE_COMMANDS,
  'environment.deploy': [],
  'database.read': [],
  'database.write': [],
  'secret.read': [],
  'permission.manage': [],
  'policy.manage': [],
};

/**
 * 没有工具落点的能力。
 *
 * ★★ 「授了但落不到实处」必须说出来。
 *
 *   `environment.deploy` 在一个只会起 CLI 子进程的运行时上没有对应动作 ——
 *   授权界面上它却和 `command.test` 长得一模一样。不报出来的话，
 *   用户以为配好了发布权限，而实际发生的是什么都没有，
 *   且没有任何一条日志说明为什么。
 */
export const CAPABILITIES_WITHOUT_TOOLS: readonly AgentCapability[] = [
  'environment.deploy',
  'database.read',
  'database.write',
  'secret.read',
];

export function toolsFor(capabilities: readonly AgentCapability[]): string[] {
  const out = new Set<string>();
  for (const c of capabilities) for (const t of CAPABILITY_TOOLS[c]) out.add(t);
  return [...out];
}

/**
 * 拒绝的能力 → 黑名单规则。
 *
 * ★ 只把**有工具落点**的拒绝写进黑名单。没有落点的拒绝写进去是空话，
 *   而空话会让黑名单看起来比实际管用 —— 这正是降级警告要治的病。
 */
export function deniedToolsFor(denied: readonly AgentCapability[]): string[] {
  const out = new Set<string>();
  for (const c of denied) for (const t of CAPABILITY_TOOLS[c]) out.add(t);
  return [...out];
}

/**
 * 授了却落不到实处的那些能力。
 *
 * ★ 用 `unenforceable` 而不是 `unavailable`：区别在于用户的下一步。
 *   unavailable 是「换个运行时」，unenforceable 是「别指望这条限制」。
 */
export function toolGapDegradations(
  capabilities: readonly AgentCapability[],
  runtimeKind: string,
): CapabilityDegradation[] {
  return capabilities
    .filter((c) => CAPABILITIES_WITHOUT_TOOLS.includes(c))
    .map((c) => ({
      capability: c,
      kind: 'unavailable' as const,
      detail: `运行时 ${runtimeKind} 没有对应这条能力的动作，授予它不会有任何效果`,
    }));
}

/**
 * 仓库范围按能力对齐。
 *
 * ★ 求值器已经做过一次同样的收窄（见 domain/capabilities/evaluate.ts）。
 *   这里再做一次不是重复：翻译器是公开接口，别的调用方可能不经过求值器
 *   直接调它，而「可写工作区」这件事不该依赖调用顺序。
 */
export function alignScopes(
  scopes: readonly ResourceScope[],
  canWrite: boolean,
): ResourceScope[] {
  return scopes.map((s) =>
    s.kind === 'repo' && s.access === 'write' && !canWrite ? { ...s, access: 'read' as const } : s,
  );
}

/** 各运行时翻译器的公共骨架 —— 差异由 options 表达 */
export function translateWithToolTable(
  input: CapabilityTranslationInput,
  options: {
    runtimeKind: string;
    /** 把基础工具名改写成这个运行时的说法；返回 null = 这个运行时没有它 */
    rename?: (tool: string) => string | null;
    extraDegradations?: (input: CapabilityTranslationInput) => CapabilityDegradation[];
  },
): CapabilityTranslation {
  const rename = options.rename ?? ((t: string) => t);
  const map = (tools: string[]) =>
    [...new Set(tools.map(rename).filter((t): t is string => t !== null))];

  const canWrite = input.capabilities.includes('workspace.write');

  return {
    allowedTools: map(toolsFor(input.capabilities)),
    deniedTools: map(deniedToolsFor(input.deniedCapabilities)),
    resourceScopes: alignScopes(input.resourceScopes, canWrite),
    degradations: [
      ...toolGapDegradations(input.capabilities, options.runtimeKind),
      ...(options.extraDegradations?.(input) ?? []),
    ],
  };
}
