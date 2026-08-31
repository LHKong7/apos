import type {
  AgentCapability,
  CapabilityDegradation,
  CapabilityTranslationInput,
  CapabilityTranslator,
} from '@apos/contracts';
import { translateWithToolTable } from './capability-map';

/**
 * 各运行时的能力翻译器。
 *
 * ★★ 「做不到」和「假装做到了」之间的差额，就是这几个文件存在的全部理由。
 *
 *   同一份授权在 Claude Code 上能落到逐次工具确认，在 Codex 上只能落到
 *   一个沙箱等级。把这件事咽下去的后果不是功能弱一点，是**授权界面在骗人**：
 *   `command.test` 那一行在两个运行时上长得一模一样，而在其中一个上，
 *   它实际的含义是「沙箱里什么命令都能跑」。
 *
 * Each runtime's translator. Their entire reason to exist is the gap between
 * "cannot" and "pretends it can": the same grant lands on per-call approval in
 * one runtime and on a coarse sandbox level in another, and a UI that shows
 * them identically is lying.
 */

/** Claude Code：粒度最细的那个 —— 带作用域的规则能逐次判 */
export const claudeCodeTranslator: CapabilityTranslator = {
  kind: 'claude_code',
  unsupported: [],
  translate: (input) => translateWithToolTable(input, { runtimeKind: 'claude_code' }),
};

/**
 * Codex：权限粒度是**沙箱级**，没有「允许 Read 但禁止 Bash」这种说法。
 *
 * ★★ 于是所有带参数的限制都表达不了。这不是缺陷说明，是必须显示给用户的
 *   一句话 —— 见 codex/permissions.ts 里同一段推理。
 */
export const codexTranslator: CapabilityTranslator = {
  kind: 'codex',
  unsupported: [],
  translate: (input) =>
    translateWithToolTable(input, {
      runtimeKind: 'codex',
      extraDegradations: sandboxGranularityWarnings('codex'),
    }),
};

/**
 * 通用 headless CLI：与 Codex 同一档粒度。
 *
 * ★ 这些 CLI 我们没有真跑过（见 cli/profile.ts 那段说明）。粒度按**最粗**
 *   假设，理由与那边一致：拿不准就降一级，选严了任务失败看得见，
 *   选松了 Agent 拿到不该有的能力看不见。
 */
function cliTranslatorFor(runtimeKind: string): CapabilityTranslator {
  return {
    kind: 'cli',
    unsupported: [],
    translate: (input) =>
      translateWithToolTable(input, {
        /**
         * ★ Two different names, deliberately. The tool table is looked up by
         *   tier — `cli` is the coarsest one and is what every unrecognized
         *   runtime gets. The warning is read by a person, so it has to name
         *   the runtime **they** configured: "运行时 cli 的权限粒度是沙箱级"
         *   points at a runtime that does not exist on their agent, and the
         *   first thing they do with it is go looking for it.
         *
         *   两个名字是刻意分开的：工具表按**档位**查，`cli` 是最粗那一档；
         *   而警告是给人读的，必须写他自己配的那个运行时 —— 「运行时 cli」
         *   指向一个他的 Agent 上并不存在的东西，读到的人第一反应是去找它。
         */
        runtimeKind: 'cli',
        extraDegradations: sandboxGranularityWarnings(runtimeKind),
      }),
  };
}

export const cliTranslator: CapabilityTranslator = cliTranslatorFor('cli');

/** Mock：测试用，工具名是它自己那套 */
export const mockTranslator: CapabilityTranslator = {
  kind: 'mock',
  unsupported: [],
  translate: (input) =>
    translateWithToolTable(input, {
      runtimeKind: 'mock',
      rename: mockToolName,
    }),
};

/**
 * Mock 运行时的词汇表。
 *
 * ★ 它不是「随便起的假名字」：计划里的 requiredTools 按运行时词汇写
 *   （见 seed-dev.ts 与 stub-provider），对不上就永远匹配不到 Agent，
 *   而症状是任务安静地停在 ready。
 *
 * ★ 多个规则映射到同一个名字是正常的：mock 的 `run_tests` 一个词覆盖了
 *   真实运行时里那一串带作用域的命令规则 —— 粒度差异本来就是这层要抹平的。
 */
const MOCK_TOOL_NAMES: Record<string, string> = {
  Read: 'read_file',
  Grep: 'read_file',
  Glob: 'read_file',
  Edit: 'write_file',
  Write: 'write_file',
  MultiEdit: 'write_file',
  NotebookEdit: 'write_file',
  'Bash(gh pr create:*)': 'create_pr',
  'Bash(gh pr merge:*)': 'merge_pr',
};

/** 带作用域的命令规则在 mock 里塌缩成两个词 */
function mockToolName(tool: string): string {
  if (MOCK_TOOL_NAMES[tool]) return MOCK_TOOL_NAMES[tool];
  if (tool.startsWith('Bash(') && tool.includes('test')) return 'run_tests';
  if (tool.startsWith('Bash(') && (tool.includes('build') || tool.includes('tsc'))) {
    return 'run_build';
  }
  if (tool === 'Bash(git push:*)') return 'push_branch';
  return tool;
}

/**
 * 沙箱级粒度表达不了的限制。
 *
 * ★★ 报的是**拒绝**那一侧，不是允许那一侧。
 *
 *   授予多了在沙箱里仍然被沙箱兜着；而拒绝表达不了才是真的漏 ——
 *   用户明确禁了「合并 PR」，沙箱却只知道「可以在工作区里执行命令」，
 *   于是那条禁令在这个运行时上根本没有落点。
 */
function sandboxGranularityWarnings(runtimeKind: string) {
  return (input: CapabilityTranslationInput): CapabilityDegradation[] => {
    const commandScoped: readonly AgentCapability[] = [
      'command.build',
      'command.test',
      'repository.push',
      'pull_request.create',
      'pull_request.merge',
    ];

    /**
     * ★ 只在沙箱**开着写权限**时才报。read-only 沙箱下这些命令本来就跑不了，
     *   那时报一句「拦不住」是虚惊 —— 而虚惊多了，真警告就没人看了。
     */
    if (!input.capabilities.includes('workspace.write')) return [];

    return input.deniedCapabilities
      .filter((c) => commandScoped.includes(c))
      .map((c) => ({
        capability: c,
        kind: 'unenforceable' as const,
        detail: `运行时 ${runtimeKind} 的权限粒度是沙箱级，无法按命令拦截；这条禁止在可写沙箱下不生效`,
      }));
  };
}

const TRANSLATORS: Record<string, CapabilityTranslator> = {
  claude_code: claudeCodeTranslator,
  codex: codexTranslator,
  mock: mockTranslator,
};

/**
 * 按运行时类型取翻译器。
 *
 * ★★ 认不出来的运行时回落到**最粗**的那一档（cli），而不是返回 null。
 *
 *   返回 null 会让求值器跳过运行时这一层 —— 也就是「不知道它做不到什么」
 *   被当成「它什么都做得到」。这个方向的默认值是这套系统里最不能接受的一种：
 *   配置没生效而现场毫无迹象。
 */
export function capabilityTranslator(runtimeKind: string): CapabilityTranslator {
  return TRANSLATORS[runtimeKind] ?? cliTranslatorFor(runtimeKind);
}
