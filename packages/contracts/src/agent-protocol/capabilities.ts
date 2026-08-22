import { z } from 'zod';
import { ResourceScope } from './index';

/**
 * 语义能力目录 —— Agent「能做什么」的稳定说法。
 *
 * ★★ 为什么要在工具名之上再加一层。
 *
 *   在这之前，「这个 Agent 能干什么」的唯一写法是运行时的工具名
 *   （`Read` / `Edit` / `Bash`）。三个后果，一个比一个隐蔽：
 *
 *   1. 用户被迫懂运行时。「要让它能跑测试」的正确答案是
 *      `Bash(npm test:*)`，而这件事没有任何地方写着。
 *   2. 换运行时等于重配一遍。同一个 Agent 从 Claude Code 换成 Codex，
 *      `Edit`、`Write` 这些词在那边根本不存在。
 *   3. **最要命的一条**：`repo:write` 这一个词同时表示三件风险差了两个
 *      数量级的事 —— 在隔离工作区里改文件、把分支推到远端、把改动合进主干。
 *      授权界面上它们长得一模一样，于是「让 Agent 能改代码」顺手把
 *      「让 Agent 能合并代码」也授了出去。
 *
 *   能力目录把这三件事拆成三个词（workspace.write / repository.push /
 *   pull_request.merge），并且与运行时无关：翻译成谁家的工具名是适配器的事
 *   （见 packages/agent-runtimes 的 capability-translators.ts）。
 *
 * ★ 这份清单在 contracts 而不是 domain，是依赖方向决定的：
 *   `@apos/agent-runtimes` 只依赖 `@apos/contracts`，而适配器必须认得能力名
 *   才能翻译。带解释的目录（风险等级、人话标签）在
 *   `@apos/domain/src/capabilities/catalog.ts`，那一层前后端共用。
 *
 * The semantic capability catalog: what an Agent may do, stated once in a
 * runtime-independent vocabulary. It exists because tool names conflated three
 * operations whose risk differs by orders of magnitude — editing files in an
 * isolated workspace, pushing to a remote, and merging — under one `repo:write`.
 * Adapters translate these names into their own tool vocabulary.
 */
export const AGENT_CAPABILITIES = [
  /** 读取工作区里的文件 / Read files in the prepared workspace */
  'workspace.read',
  /** 在**隔离工作区**里改文件。改动不会离开工作区 / Edit files in the isolated workspace only */
  'workspace.write',
  'command.build',
  'command.test',
  /** 访问外部网络。默认关 —— 它同时是数据外泄的通道 / Reach the public network */
  'network.external',
  'artifact.create',
  /** 把分支推到远端仓库 / Push branches to the remote */
  'repository.push',
  'pull_request.create',
  /** 把改动合进目标分支 —— 这一条之后就没有人工复核了 / Merge; nothing reviews after this */
  'pull_request.merge',
  'environment.deploy',
  'database.read',
  'database.write',
  'secret.read',
  /** 改权限本身 —— 授出去等于取消整套治理 / Change permissions; granting this ends governance */
  'permission.manage',
  'policy.manage',
] as const;

export const AgentCapability = z.enum(AGENT_CAPABILITIES);
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export function isAgentCapability(value: string): value is AgentCapability {
  return (AGENT_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * 一条能力是从哪儿来的（或者被谁挡掉的）。
 *
 * ★★ 事后追责问的从来不是「它当时能不能推分支」，而是「**谁**让它能推的」。
 *   没有出处，一条权限的来源有五种可能，而它们的下一步完全不同：
 *   改项目授权、改 Agent 上限、换运行时、改平台基线、还是撤掉一条显式覆盖。
 *
 * Where a capability came from, or what removed it. Audit never asks "could it
 * push" — it asks who made it able to, and the five possible answers have five
 * different remediations.
 */
export const PermissionSource = z.object({
  capability: AgentCapability,
  source: z.enum([
    /** 平台安全基线：任何配置都放不开 / Platform baseline; nothing can grant it */
    'platform_baseline',
    /** 组织给这个 Agent 定的能力上限 / The org-level ceiling on this Agent */
    'agent_ceiling',
    /** 项目里选的能力档案 / The capability profile chosen in this project */
    'project_profile',
    /** 平台默认（没配过任何东西时用的那份） / Platform default for an unconfigured Agent */
    'project_default',
    /** 在档案之上单独加/减的一条 / A single capability added or removed on top of the profile */
    'explicit_override',
    /** 运行时做不到 —— 授了也没用 / The runtime cannot do it; granting is moot */
    'runtime_unsupported',
  ]),
  /** true = 这条来源是**拿掉**它的原因 / true when this source is why the capability is absent */
  denied: z.boolean().default(false),
});
export type PermissionSource = z.infer<typeof PermissionSource>;

/**
 * 运行时翻译不出来的那部分。
 *
 * ★★ 必须显示，不能吞。
 *
 *   Codex 的权限粒度是沙箱级，表达不了「能跑测试但不能跑 rm」。把这件事
 *   咽下去的话，界面上那条 `command.test` 看起来和 Claude Code 上的
 *   一模一样 —— 用户以为限制住了，而实际上沙箱里什么命令都能跑。
 *   授权界面骗人比授权界面难用糟得多。
 *
 * What the runtime cannot enforce. Never swallowed: a capability that looks
 * granted-and-bounded in the UI but is unbounded at runtime is worse than an
 * awkward UI, because nobody goes looking for it.
 */
export const CapabilityDegradation = z.object({
  capability: AgentCapability,
  /** 'unenforceable' = 授了但拦不住多余的；'unavailable' = 运行时压根做不到 */
  kind: z.enum(['unenforceable', 'unavailable']),
  detail: z.string(),
});
export type CapabilityDegradation = z.infer<typeof CapabilityDegradation>;

/**
 * 语义能力 → 某个运行时的工具集。
 *
 * ★★ 接口定在 contracts，实现放在各适配器里，求值器只认这个口子 ——
 *   这是「调用方不区分具体运行时」那条约定在权限这一侧的落点。
 *   把翻译写进求值器的话，domain 就得认得每一种 CLI 的工具名，
 *   而新增一种运行时会变成改 domain。
 *
 * ★ 返回的是**结果加代价**：翻译不出来的部分必须出现在 degradations 里，
 *   由界面显示。适配器可以做不到，但不可以不说。
 *
 * Semantic capabilities to one runtime's tool vocabulary. The interface lives
 * in contracts and each adapter implements it, so the evaluator never learns
 * any CLI's tool names. A translator may fail to express something; it may not
 * stay quiet about it.
 */
export interface CapabilityTranslationInput {
  capabilities: readonly AgentCapability[];
  deniedCapabilities: readonly AgentCapability[];
  resourceScopes: readonly ResourceScope[];
  runtimeManifest: unknown;
}

export interface CapabilityTranslation {
  allowedTools: string[];
  deniedTools: string[];
  resourceScopes: ResourceScope[];
  degradations: CapabilityDegradation[];
}

export interface CapabilityTranslator {
  readonly kind: string;
  /** 这个运行时压根做不到的能力 —— 求值时会被交集掉 */
  readonly unsupported: readonly AgentCapability[];
  translate(input: CapabilityTranslationInput): CapabilityTranslation;
}

/**
 * 派发时冻结的权限快照（v2）。
 *
 * ★★ v1 只有三个运行时字段（allowedTools / deniedTools / resourceScopes）。
 *   它们回答得了「当时它能调什么工具」，回答不了「当时它被授权做什么」——
 *   而半年后翻审计的人问的是后者。运行时字段还会随适配器升级改写含义：
 *   同一串 `['Read','Edit']` 在适配器改版前后不是一回事。
 *
 * ★ v1 快照**原样保留**，不迁移、不补写。历史快照是当时那次执行的凭证，
 *   改写它等于伪造证据 —— 读取侧靠 `version` 分辨（缺省即 v1）。
 *
 * The dispatch-time snapshot. v1 recorded only runtime tool names, which answer
 * "what could it call" but not "what was it authorized to do" — and the latter
 * is what an audit six months later asks. Old snapshots are never rewritten:
 * they are the evidence of that run, and `version` tells them apart.
 */
export const AgentPermissionSnapshot = z.object({
  version: z.literal(2),
  profileKey: z.string(),
  profileVersion: z.number().int(),

  capabilities: z.array(AgentCapability),
  deniedCapabilities: z.array(AgentCapability),

  allowedTools: z.array(z.string()),
  deniedTools: z.array(z.string()),
  resourceScopes: z.array(ResourceScope),

  sources: z.array(PermissionSource).default([]),
  degradations: z.array(CapabilityDegradation).default([]),
});
export type AgentPermissionSnapshot = z.infer<typeof AgentPermissionSnapshot>;
