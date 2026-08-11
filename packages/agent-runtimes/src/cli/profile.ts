import type { CapabilityManifest } from '@apos/contracts';
import type { MappedSandbox } from '../codex/permissions';

/**
 * Headless CLI 的差异描述。
 *
 * ★★ 为什么是一张声明式的表，而不是六个各写四百行的适配器：
 *
 *   把 codex 那个适配器抄六遍，抄的其实是同一份东西 —— 起子进程、设 cwd、
 *   给最小环境、超时、SIGTERM 之后补 SIGKILL、留 stderr 尾巴、把权限降级成
 *   沙箱等级、把事件按 seq 串起来。这些对所有 CLI 一模一样，而且是**已经
 *   在 codex 上跑通过的**部分。
 *
 *   真正不同的只有五件事：可执行文件叫什么、argv 怎么拼、prompt 从哪进去、
 *   输出是什么形态、凭证放哪个环境变量。它们是数据，不是逻辑。
 *
 * ★★ 还有一条更重要的理由：**这六个 CLI 我们没有真跑过。**
 *
 *   它们的输出格式来自各自的文档（见每个 profile 上的引用），不是实测。
 *   为一个没验证过的 JSON schema 写四百行专用解析器，产出的是看起来很完整、
 *   第一次真跑就崩的代码 —— 而且崩在解析层，报错完全指不到「文档和实现对不上」。
 *
 *   声明式 + 防御式解析（见 translate.ts）意味着：跑起来发现哪里不对，
 *   改的是这张表里的一行数据，不是一个解析器。
 */

/** prompt 怎么送进去 */
export type PromptDelivery =
  /** 写进 stdin 后关闭 —— 最稳，不受 argv 长度限制，也不进 ps 输出 */
  | 'stdin'
  /** 作为最后一个位置参数 */
  | 'arg'
  /** 跟在某个 flag 后面，如 `-p <prompt>` */
  | { flag: string };

export type OutputFormat =
  /** 每行一个 JSON 事件，可以边跑边出 */
  | 'stream-json'
  /** 整个 stdout 是一个 JSON 对象，只能跑完再解析 */
  | 'json'
  /** 人读的文本，没有结构 */
  | 'text';

export interface CliArgContext {
  sandbox: MappedSandbox;
  model: string | null;
  workspacePath: string | null;
  /** 用户在 Agent 配置里填的额外参数 */
  extraArgs: string[];
}

export interface CliProfile {
  kind: string;
  label: string;
  /** 默认可执行文件名；用户可在配置里覆盖 */
  binary: string;
  buildArgs: (ctx: CliArgContext) => string[];
  promptDelivery: PromptDelivery;
  output: OutputFormat;
  /**
   * 凭证注入到子进程的哪个环境变量。
   * null = 该 CLI 自己管登录态（如 OAuth 缓存），平台不注入。
   */
  credentialEnv: string | null;
  /**
   * 平台侧的专用凭证变量名。
   * ★ 与人类/平台自己用的那个分开 —— 产品文档 10.2：Agent 是独立身份。
   */
  dedicatedEnv: string | null;
  /** 允许沿用的进程环境变量名（仅在 Agent 没登记凭证时） */
  inheritEnv: string | null;
  /** 自建网关地址注入到哪个环境变量；null = 不支持 */
  baseUrlEnv: string | null;
  /** 如实声明。夸大的后果是页面上显示了一个永远不会到来的进度条 */
  features: Partial<CapabilityManifest['features']>;
  /** 找不到可执行文件时告诉运维该装什么 */
  installHint: string;
  defaultModel: string | null;
  /** 文档出处，方便下一个人核对 */
  docs: string;
}

/** 六个 CLI 共有的能力上限：都是单次执行的子进程，起跑后没有输入通道 */
const SPAWNED_CLI_BASE: Partial<CapabilityManifest['features']> = {
  // 单次执行，起跑后无法追加消息
  runtimeConstraints: false,
  // 没有渠道把「我需要这个权限」变成人类待办
  interventionRequest: false,
  pause: false,
  terminate: true,
  statusQuery: true,
  subAgentDelegation: false,
  artifactUpload: false,
};

/**
 * Pi Coding Agent（earendil-works/pi）。
 *
 * ★★ prompt 必须跟在 `-p` 后面，**不能**走 stdin。
 *
 *   `pi` 的 stdin 是**额外上下文**而不是指令 —— 文档里的用法是
 *   `cat README.md | pi -p "Summarize this text"`：管道里是数据，
 *   `-p` 里是要它做什么。把 prompt 挪到 stdin、留一个空的 `-p`，
 *   结果是 `-p` 吞掉后面那个参数（或直接报缺参数），而任务描述根本没送到。
 *
 * ★ 已知坑（上游 issue #4163）：`-p` 的内容以 `---` 开头时会静默退出 0
 *   且什么都不做。我们的 prompt 前缀是治理规则文本，不会以 `---` 开头。
 */
export const PI_PROFILE: CliProfile = {
  kind: 'pi',
  label: 'Pi Coding Agent',
  binary: 'pi',
  promptDelivery: { flag: '-p' },
  output: 'text',
  credentialEnv: 'ANTHROPIC_API_KEY',
  dedicatedEnv: 'APOS_AGENT_PI_API_KEY',
  inheritEnv: 'ANTHROPIC_API_KEY',
  baseUrlEnv: null,
  defaultModel: null,
  buildArgs: ({ model, extraArgs }) => [
    ...(model ? ['--model', model] : []),
    ...extraArgs,
  ],
  features: {
    ...SPAWNED_CLI_BASE,
    // 纯文本输出：拿不到结构化的工具调用与用量
    streamingEvents: true, // 文本是逐行来的，至少能看到它在动
    toolCallVisibility: false,
    reasoningVisibility: false,
    costReporting: false,
    tokenReporting: false,
    progressReporting: false,
    selfReportOnFailure: false,
  },
  installHint: 'npm i -g --ignore-scripts @earendil-works/pi-coding-agent，或 curl -fsSL https://pi.dev/install.sh | sh',
  docs: 'https://pi.dev/docs/latest/usage',
};

/**
 * Gemini CLI（google-gemini/gemini-cli）。
 *
 * ★★ 输出是**一个** JSON 对象，不是 JSON 流 —— 只能等进程退出后整体解析。
 *   所以 streamingEvents 是 false：执行过程中界面上不会有任何动静，
 *   一直到结束才一次性出结果。这一条如实写进能力清单，
 *   否则用户会盯着一个永远不动的进度条以为卡死了。
 *
 * ★ `--yolo` 是自动批准。非交互下不给它，CLI 会在需要确认时挂起等终端输入，
 *   而这里没有终端 —— 表现是 Run 卡到超时（与 codex 的 approvalPolicy 同一个坑）。
 *   只在沙箱允许写的时候给，只读任务不需要放开批准。
 */
export const GEMINI_PROFILE: CliProfile = {
  kind: 'gemini_cli',
  label: 'Gemini CLI',
  binary: 'gemini',
  promptDelivery: { flag: '-p' },
  output: 'json',
  credentialEnv: 'GEMINI_API_KEY',
  dedicatedEnv: 'APOS_AGENT_GEMINI_API_KEY',
  inheritEnv: 'GEMINI_API_KEY',
  baseUrlEnv: null,
  defaultModel: 'gemini-2.5-pro',
  buildArgs: ({ sandbox, model, extraArgs }) => [
    '--output-format',
    'json',
    ...(model ? ['-m', model] : []),
    ...(sandbox.mode === 'read-only' ? [] : ['--yolo']),
    ...extraArgs,
  ],
  features: {
    ...SPAWNED_CLI_BASE,
    // 单个 JSON 对象 —— 跑完才有输出
    streamingEvents: false,
    toolCallVisibility: false,
    reasoningVisibility: false,
    // 返回体里带 usage 统计
    costReporting: false,
    tokenReporting: true,
    progressReporting: false,
    selfReportOnFailure: false,
  },
  installHint: 'npm i -g @google/gemini-cli',
  docs: 'https://google-gemini.github.io/gemini-cli/docs/cli/headless.html',
};

/**
 * Aider（Aider-AI/aider）。
 *
 * ★ 纯文本 CLI，没有任何结构化输出通道。`-m` 送一条消息、处理完就退出，
 *   `--yes-always` 免掉交互确认 —— 少了它在非交互环境里会挂住。
 *
 * ★ `--no-stream` 是有意的：流式输出会把 token 一个个打出来，
 *   在我们这里只会变成几百条毫无信息量的 note。
 *
 * ★★ Aider 自带 git 提交。而平台侧的 WorkspaceProvisioner 也管提交
 *   （provisioner.ts 的 release 流程）—— 两边都提交会让 Run 的产物
 *   多出一堆 aider 风格的提交。这里加 `--no-auto-commits` 把提交权
 *   留给平台，保证「一个 Run 一次提交」这条不变量。
 */
export const AIDER_PROFILE: CliProfile = {
  kind: 'aider',
  label: 'Aider',
  binary: 'aider',
  promptDelivery: { flag: '-m' },
  output: 'text',
  credentialEnv: 'OPENAI_API_KEY',
  dedicatedEnv: 'APOS_AGENT_AIDER_API_KEY',
  inheritEnv: 'OPENAI_API_KEY',
  baseUrlEnv: 'OPENAI_API_BASE',
  defaultModel: null,
  buildArgs: ({ model, extraArgs }) => [
    '--yes-always',
    '--no-stream',
    '--no-auto-commits',
    '--no-show-release-notes',
    '--no-check-update',
    ...(model ? ['--model', model] : []),
    ...extraArgs,
  ],
  features: {
    ...SPAWNED_CLI_BASE,
    streamingEvents: true,
    toolCallVisibility: false,
    reasoningVisibility: false,
    // 会在收尾时打印 token 与花费，但格式是给人看的，不作为权威值
    costReporting: false,
    tokenReporting: false,
    progressReporting: false,
    selfReportOnFailure: false,
  },
  installHint: 'python -m pip install aider-install && aider-install（或 pipx install aider-chat）',
  docs: 'https://aider.chat/docs/scripting.html',
};

/**
 * Goose（block/goose）。
 *
 * ★ 六个里少数支持 `stream-json` 的 —— 能边跑边出事件，
 *   所以 streamingEvents 为 true。
 *
 * ★★ 非交互下必须是 Auto 模式：Approve / SmartApprove 会**显式拒绝**
 *   在非交互环境运行并报错退出。这里不开放审批档位配置，
 *   开放了也只有一个值可用，徒增一个能把自己配坏的旋钮。
 */
export const GOOSE_PROFILE: CliProfile = {
  kind: 'goose',
  label: 'Goose',
  binary: 'goose',
  promptDelivery: 'stdin',
  output: 'stream-json',
  credentialEnv: 'ANTHROPIC_API_KEY',
  dedicatedEnv: 'APOS_AGENT_GOOSE_API_KEY',
  inheritEnv: 'ANTHROPIC_API_KEY',
  baseUrlEnv: null,
  defaultModel: null,
  buildArgs: ({ extraArgs }) => [
    'run',
    '--output-format',
    'stream-json',
    ...extraArgs,
  ],
  features: {
    ...SPAWNED_CLI_BASE,
    streamingEvents: true,
    toolCallVisibility: true,
    reasoningVisibility: false,
    costReporting: false,
    tokenReporting: true,
    progressReporting: false,
    selfReportOnFailure: false,
  },
  installHint: 'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash',
  docs: 'https://goose-docs.ai/docs/guides/goose-cli-commands/',
};

/**
 * OpenCode（sst/opencode）。
 *
 * ★ `opencode run "<prompt>"` 走位置参数。模型格式是 `provider/model`
 *   （如 `anthropic/claude-sonnet-4`），与其他几个只填模型名不同 ——
 *   填错的表现是 CLI 报「unknown model」，所以配置项的说明里要写清楚。
 */
export const OPENCODE_PROFILE: CliProfile = {
  kind: 'opencode',
  label: 'OpenCode',
  binary: 'opencode',
  promptDelivery: 'arg',
  output: 'text',
  credentialEnv: 'ANTHROPIC_API_KEY',
  dedicatedEnv: 'APOS_AGENT_OPENCODE_API_KEY',
  inheritEnv: 'ANTHROPIC_API_KEY',
  baseUrlEnv: null,
  defaultModel: null,
  buildArgs: ({ model, extraArgs }) => [
    'run',
    ...(model ? ['--model', model] : []),
    ...extraArgs,
  ],
  features: {
    ...SPAWNED_CLI_BASE,
    streamingEvents: true,
    toolCallVisibility: false,
    reasoningVisibility: false,
    costReporting: false,
    tokenReporting: false,
    progressReporting: false,
    selfReportOnFailure: false,
  },
  installHint: 'curl -fsSL https://opencode.ai/install | bash（或 npm i -g opencode-ai）',
  docs: 'https://open-code.ai/en/docs/cli',
};

/**
 * Qwen Code（QwenLM/qwen-code）。
 *
 * ★ 它是 gemini-cli 的 fork，flag 高度相似，但**多了 stream-json**，
 *   所以这里选流式而不是像 gemini 那样只能等收尾。
 *
 * ★ `--max-session-turns` 是成本闸门。不设的话一个绕不出来的任务
 *   会一直转到墙钟超时，而那时候钱已经花完了。
 */
export const QWEN_PROFILE: CliProfile = {
  kind: 'qwen_code',
  label: 'Qwen Code',
  binary: 'qwen',
  promptDelivery: { flag: '-p' },
  output: 'stream-json',
  credentialEnv: 'OPENAI_API_KEY',
  dedicatedEnv: 'APOS_AGENT_QWEN_API_KEY',
  inheritEnv: 'OPENAI_API_KEY',
  baseUrlEnv: 'OPENAI_BASE_URL',
  defaultModel: 'qwen3-coder-plus',
  buildArgs: ({ sandbox, model, extraArgs }) => [
    '--output-format',
    'stream-json',
    ...(model ? ['-m', model] : []),
    ...(sandbox.mode === 'read-only' ? [] : ['--approval-mode', 'yolo']),
    ...extraArgs,
  ],
  features: {
    ...SPAWNED_CLI_BASE,
    streamingEvents: true,
    toolCallVisibility: true,
    reasoningVisibility: false,
    costReporting: false,
    tokenReporting: true,
    progressReporting: false,
    selfReportOnFailure: false,
  },
  installHint: 'npm i -g @qwen-code/qwen-code',
  docs: 'https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/',
};

export const CLI_PROFILES: CliProfile[] = [
  PI_PROFILE,
  GEMINI_PROFILE,
  AIDER_PROFILE,
  GOOSE_PROFILE,
  OPENCODE_PROFILE,
  QWEN_PROFILE,
];

export function cliProfile(kind: string): CliProfile | null {
  return CLI_PROFILES.find((p) => p.kind === kind) ?? null;
}
