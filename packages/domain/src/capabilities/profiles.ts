import type { AgentCapability } from '@apos/contracts';
import { expandImplied, sortCapabilities } from './catalog';

/**
 * 能力档案 —— 用户实际要做的那个选择。
 *
 * ★★ 这一层存在的理由是「没配置 ≠ 没权限」。
 *
 *   在它出现之前，一个刚建出来的 Agent 的权限是空数组，含义是「什么都不能干」。
 *   于是每个人都得先学一遍运行时的工具名，才能让 Agent 干活 —— 而学不会的人
 *   会把 allowedTools 填成一长串「先能跑起来再说」。默认值不安全的系统里，
 *   真正的默认值是用户从别处抄来的那份配置。
 *
 *   档案把这件事翻过来：没配置就用一份**安全且够用**的默认档案，
 *   而要更多能力得是一个明确的、要写理由的决定。
 *
 * ★★ 档案带版本，而且**展开结果落库**（见 project_agent_permissions）。
 *   不落库的话，平台哪天给 standard_executor 加一条能力，所有在跑的 Agent
 *   会在没有任何人做过决定的情况下一起变宽 —— 这正是「权限累积」
 *   （docs/tech/09-security.md §7）最典型的发生方式。
 *
 * A capability profile is the choice a user actually makes. Profiles exist so
 * that "not configured" means "the safe useful default" instead of "no
 * permissions" — because in a system whose default is unusable, the real
 * default becomes whatever configuration people copy from elsewhere. Profiles
 * are versioned and their expansion is stored, so upgrading a profile never
 * silently widens agents nobody touched.
 */

export interface CapabilityProfile {
  key: string;
  version: number;
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  capabilities: readonly AgentCapability[];
  /**
   * 档案自带的硬拒绝。
   *
   * ★ 拒绝比「不授予」强：不授予只是这次没给，而拒绝在合并时压过一切上游允许
   *   （见 evaluate.ts）。standard_executor 明确拒绝 push / merge / deploy，
   *   是为了让「把它加进一个宽松项目」不会顺手把这些能力带进来。
   */
  deniedCapabilities: readonly AgentCapability[];
}

/**
 * 默认档案 —— Agent 进项目时没指定就是它。
 *
 * ★ 能在隔离工作区里改代码、跑测试、交产物；不能发布、不能合并、不能部署、
 *   不能读凭证、不能改治理。这条界线的判据是「后果出不出得了工作区」。
 */
export const STANDARD_EXECUTOR: CapabilityProfile = {
  key: 'standard_executor',
  version: 1,
  name: '标准执行者',
  nameEn: 'Standard executor',
  description: '在隔离工作区里改代码、跑测试、交产物。改动不会自己离开工作区。',
  descriptionEn:
    'Edits code, runs tests and submits artifacts inside an isolated workspace. Nothing leaves it on its own.',
  capabilities: [
    'workspace.read',
    'workspace.write',
    'command.build',
    'command.test',
    'artifact.create',
  ],
  deniedCapabilities: [
    'repository.push',
    'pull_request.merge',
    'environment.deploy',
    'database.write',
    'secret.read',
    'permission.manage',
    'policy.manage',
  ],
};

/**
 * 只读评审者。
 *
 * ★ review Agent 该只读 —— 这个区别是整套治理体系里最该说清楚的一件事
 *   （见 permissions/resource-scopes.ts 里同一句话）。有了档案之后它终于
 *   有了一个能选中的名字，而不是「记得把 Edit 从工具列表里删掉」。
 */
export const READONLY_REVIEWER: CapabilityProfile = {
  key: 'readonly_reviewer',
  version: 1,
  name: '只读评审者',
  nameEn: 'Read-only reviewer',
  description: '只看不改：读代码、跑测试、写评审意见。',
  descriptionEn: 'Looks without touching: reads code, runs tests, writes review notes.',
  capabilities: ['workspace.read', 'command.test', 'artifact.create'],
  deniedCapabilities: [
    'workspace.write',
    'repository.push',
    'pull_request.create',
    'pull_request.merge',
    'environment.deploy',
    'database.write',
    'secret.read',
    'permission.manage',
    'policy.manage',
  ],
};

/**
 * 能开 PR 的开发者。
 *
 * ★★ 它与 standard_executor 的差别**只有一条**：能推分支、能开 PR，
 *   仍然不能合并。这是刻意的 —— 「Agent 把活干完、人来点合并」是这套产品
 *   预设的协作形态，而 merge 是它与「Agent 自己说了算」之间唯一的那道闸。
 */
export const CODE_DEVELOPER: CapabilityProfile = {
  key: 'code_developer',
  version: 1,
  name: '代码开发者',
  nameEn: 'Code developer',
  description: '在标准执行者之上，还能把分支推到远端并开 PR。合并仍然要人点。',
  descriptionEn:
    'A standard executor that may also push branches and open pull requests. Merging still needs a person.',
  capabilities: [
    'workspace.read',
    'workspace.write',
    'command.build',
    'command.test',
    'artifact.create',
    'repository.push',
    'pull_request.create',
  ],
  deniedCapabilities: [
    'pull_request.merge',
    'environment.deploy',
    'database.write',
    'secret.read',
    'permission.manage',
    'policy.manage',
  ],
};

/**
 * 规划者 —— 读需求、出计划，不碰代码。
 *
 * ★ 规划 Run 没有代码工作区（见 agent_runs.work_item_id 可空那段注释）。
 *   给它工作区写权限没有意义，而「没意义的权限」在审计里与「有意授出去的
 *   权限」长得一模一样。
 */
export const PLANNER: CapabilityProfile = {
  key: 'planner',
  version: 1,
  name: '规划者',
  nameEn: 'Planner',
  description: '读需求与代码、产出计划文档，不改任何东西。',
  descriptionEn: 'Reads requirements and code, produces plans, changes nothing.',
  capabilities: ['workspace.read', 'artifact.create'],
  deniedCapabilities: [
    'workspace.write',
    'repository.push',
    'pull_request.create',
    'pull_request.merge',
    'environment.deploy',
    'database.write',
    'secret.read',
    'permission.manage',
    'policy.manage',
  ],
};

export const BUILTIN_CAPABILITY_PROFILES: readonly CapabilityProfile[] = [
  STANDARD_EXECUTOR,
  READONLY_REVIEWER,
  CODE_DEVELOPER,
  PLANNER,
];

/** Agent 进项目时没指定档案就是它 */
export const DEFAULT_PROFILE_KEY = STANDARD_EXECUTOR.key;

export function capabilityProfile(key: string): CapabilityProfile | null {
  return BUILTIN_CAPABILITY_PROFILES.find((p) => p.key === key) ?? null;
}

export interface ExpandedProfile {
  profileKey: string;
  profileVersion: number;
  allowedCapabilities: AgentCapability[];
  deniedCapabilities: AgentCapability[];
}

/**
 * 把档案展开成一份可落库的能力清单。
 *
 * ★★ 展开必须是**确定性**的：同样的输入永远得到同样的、顺序一致的两个数组。
 *   不确定的话，每次保存都会在审计里留下一条「权限变了」，而真正变了的那次
 *   就淹没在噪音里。
 *
 * ★ 隐含能力在这里就展开（push → workspace.write → workspace.read），
 *   而不是留到求值时：落库的那份要能独立读懂，否则「档案升级不影响老 Agent」
 *   这个承诺就依赖于展开逻辑本身永远不变。
 *
 * ★ 拒绝在展开阶段就压过允许。同一条能力既在 capabilities 又在
 *   deniedCapabilities 里是配置错误，而它的正确解读只有一种 —— 拒绝优先，
 *   因为反过来会让一条写着「禁止」的配置放行。
 */
export function expandProfile(
  profile: CapabilityProfile,
  overrides: {
    /** 在档案之上额外加的（仍受上限与基线约束） */
    add?: readonly AgentCapability[];
    /** 在档案之上额外减的 */
    remove?: readonly AgentCapability[];
  } = {},
): ExpandedProfile {
  const denied = sortCapabilities([...profile.deniedCapabilities, ...(overrides.remove ?? [])]);
  const deniedSet = new Set(denied);

  const allowed = expandImplied([...profile.capabilities, ...(overrides.add ?? [])]).filter(
    (c) => !deniedSet.has(c),
  );

  return {
    profileKey: profile.key,
    profileVersion: profile.version,
    allowedCapabilities: sortCapabilities(allowed),
    deniedCapabilities: denied,
  };
}

/** 默认档案的展开结果 —— 「没配置」时用的那一份 */
export function defaultExpandedProfile(): ExpandedProfile {
  return expandProfile(STANDARD_EXECUTOR);
}
