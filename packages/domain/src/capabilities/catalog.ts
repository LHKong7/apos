import { AGENT_CAPABILITIES, type AgentCapability } from '@apos/contracts';

/**
 * 能力目录 —— 每条能力的人话说明、风险等级与硬约束。
 *
 * ★ 能力名本身在 `@apos/contracts`（适配器要认它，而适配器够不到 domain）。
 *   这里加的是**解释**：授权界面靠它把「repository.push」写成一句用户看得懂的
 *   后果，Policy 与治理靠 `risk` 决定要不要人工确认。
 *
 * ★ 目录是数据不是代码。新增一条能力 = 在 contracts 的清单里加一行 +
 *   在这里补一条说明 + 在每个适配器的翻译表里给出映射。三处缺一处都有
 *   编译期或启动期的检查兜着（见本文件末尾与 translator 的穷举断言）。
 */

export type CapabilityRisk =
  /** 只读，出不了工作区 / Read-only, cannot leave the workspace */
  | 'low'
  /** 有副作用但可回退 / Has effects, but they can be undone */
  | 'medium'
  /** 改动会离开平台的控制范围 / The effect leaves the platform's reach */
  | 'high'
  /** 授出去等于取消治理本身 / Granting it cancels governance itself */
  | 'critical';

export interface CapabilitySpec {
  /** 人话标签（中文） */
  label: string;
  /** 英文标签 —— 这一份是给不读中文的人的，不是逐字翻译 */
  labelEn: string;
  /** 用户点「授予」之前该知道的后果 */
  consequence: string;
  consequenceEn: string;
  risk: CapabilityRisk;
  /**
   * ★★ 永远不能授予 Agent。
   *
   *   与 RBAC 里的 `humanOnly` 是同一条纪律（见 rbac/catalog.ts §7.2）：
   *   「如果 Agent 能改自己的约束，整个治理体系就是装饰。」
   *   这里不依赖「当前没有 Agent 令牌」这个事实 —— 口子现在就是关着的。
   *
   *   Never grantable to an Agent, for the same reason `humanOnly` exists in the
   *   RBAC catalogue: an Agent that can widen its own constraints makes the
   *   whole governance model decorative.
   */
  neverAutoGrant?: boolean;
  /**
   * 授予这条就隐含授予了那几条。
   *
   * ★ 只写**真正的**前置，不写「一般也会一起给」。把习惯写成隐含依赖，
   *   等于在用户没看见的地方偷偷放宽 —— 而放宽正是这套目录要看住的方向。
   */
  implies?: readonly AgentCapability[];
}

export const CAPABILITY_SPECS: Record<AgentCapability, CapabilitySpec> = {
  'workspace.read': {
    label: '读取工作区文件',
    labelEn: 'Read workspace files',
    consequence: '能看到本次任务工作区里的代码与文档。',
    consequenceEn: 'Can see the code and documents in this run’s workspace.',
    risk: 'low',
  },
  'workspace.write': {
    label: '修改工作区文件',
    labelEn: 'Edit workspace files',
    /**
     * ★ 这句话是整个目录里最该说准的一句。用户脑子里的「让它改代码」
     *   通常包含「然后提交上去」，而这一条到工作区为止。
     */
    consequence: '能在隔离工作区里改文件。改动不会自己离开工作区 —— 推送与合并是另外两条能力。',
    consequenceEn:
      'Can edit files inside the isolated workspace. Nothing leaves it on its own — pushing and merging are separate capabilities.',
    risk: 'medium',
    implies: ['workspace.read'],
  },
  'command.build': {
    label: '执行构建',
    labelEn: 'Run builds',
    consequence: '能在工作区里跑构建命令。',
    consequenceEn: 'Can run build commands inside the workspace.',
    risk: 'medium',
    implies: ['workspace.read'],
  },
  'command.test': {
    label: '运行测试',
    labelEn: 'Run tests',
    consequence: '能在工作区里跑测试。',
    consequenceEn: 'Can run the test suite inside the workspace.',
    risk: 'medium',
    implies: ['workspace.read'],
  },
  'network.external': {
    label: '访问外部网络',
    labelEn: 'Reach the public network',
    /**
     * ★ 说清它是**双向**的。用户想要的是「能查文档」，而同一条通道
     *   也能把工作区里的代码发出去。只说前一半的授权界面是在误导。
     */
    consequence: '能访问公网。这条通道同时能把工作区里的内容发出去。',
    consequenceEn:
      'Can reach the public network. The same channel can also send workspace contents out.',
    risk: 'high',
  },
  'artifact.create': {
    label: '产出交付物',
    labelEn: 'Produce artifacts',
    consequence: '能提交执行摘要、文档这类产物给人评审。',
    consequenceEn: 'Can submit summaries and documents for human review.',
    risk: 'low',
  },
  'repository.push': {
    label: '推送到远端仓库',
    labelEn: 'Push to the remote repository',
    consequence: '能把分支推到远端。改动从此离开平台的控制范围。',
    consequenceEn: 'Can push branches to the remote. The change leaves the platform’s reach.',
    risk: 'high',
    implies: ['workspace.write'],
  },
  'pull_request.create': {
    label: '创建 Pull Request',
    labelEn: 'Open pull requests',
    consequence: '能开 PR 请人评审。合并仍需另一条能力。',
    consequenceEn: 'Can open a PR for review. Merging still needs a separate capability.',
    risk: 'medium',
    implies: ['repository.push'],
  },
  'pull_request.merge': {
    label: '合并 Pull Request',
    labelEn: 'Merge pull requests',
    /** ★ 「这一条之后没有人再看一眼」——授权界面上必须是这句话，不是「合并代码」 */
    consequence: '能把改动合进目标分支。这一步之后没有任何人工复核。',
    consequenceEn: 'Can merge into the target branch. Nothing human reviews it after this.',
    risk: 'critical',
    implies: ['pull_request.create'],
  },
  'environment.deploy': {
    label: '部署到环境',
    labelEn: 'Deploy to an environment',
    consequence: '能把改动发布到实际运行的环境上。',
    consequenceEn: 'Can release changes to a running environment.',
    risk: 'critical',
  },
  'database.read': {
    label: '读取数据库',
    labelEn: 'Read the database',
    consequence: '能查询已授权的数据库。生产数据里含有真实用户信息。',
    consequenceEn: 'Can query granted databases. Production data contains real user information.',
    risk: 'high',
  },
  'database.write': {
    label: '写入数据库',
    labelEn: 'Write to the database',
    consequence: '能改数据库里的数据与结构。数据损坏通常不可回退。',
    consequenceEn: 'Can change data and schema. Damage here is usually not reversible.',
    risk: 'critical',
  },
  'secret.read': {
    label: '读取凭证',
    labelEn: 'Read secrets',
    consequence: '能读到明文凭证。凭证一旦进入模型上下文，就必须当作已泄露来处理。',
    consequenceEn:
      'Can read secrets in the clear. Once a secret enters a model context it must be treated as leaked.',
    risk: 'critical',
  },
  'permission.manage': {
    label: '管理权限',
    labelEn: 'Manage permissions',
    consequence: '能改权限配置 —— 包括它自己的。',
    consequenceEn: 'Can change permission configuration, including its own.',
    risk: 'critical',
    neverAutoGrant: true,
  },
  'policy.manage': {
    label: '管理 Policy',
    labelEn: 'Manage policies',
    consequence: '能改治理规则 —— 包括那些本来会拦住它的规则。',
    consequenceEn: 'Can change governance rules, including the ones that would stop it.',
    risk: 'critical',
    neverAutoGrant: true,
  },
};

/**
 * 平台安全底线：**任何**配置都授不出去的能力。
 *
 * ★★ 与 Policy 的 `NEVER_AUTO_APPROVE` 是同一条底线的两半：那边管
 *   「这件事不能自动放行」，这边管「这个身份根本不该有这个能力」。
 *   两边都红了才叫治理被绕过，所以两边都有阻断性测试。
 *
 * The platform baseline: capabilities no configuration can grant. The twin of
 * policy's NEVER_AUTO_APPROVE — that one bars automatic approval, this one bars
 * the capability existing at all.
 */
export const PLATFORM_DENIED_CAPABILITIES: readonly AgentCapability[] = AGENT_CAPABILITIES.filter(
  (c) => CAPABILITY_SPECS[c].neverAutoGrant === true,
);

/**
 * 展开隐含能力。
 *
 * ★ 授了 `repository.push` 却没授 `workspace.write` 是配置不出可用状态的：
 *   没有工作区写权限就没有东西可推。不展开的话，用户会得到一个能力齐全、
 *   实际什么也干不成的 Agent，而失败发生在派发之后。
 *
 * ★ 展开是**闭包**：push → workspace.write → workspace.read。逐层跟到底，
 *   否则「加一条中间能力」会让下面那层悄悄掉出去。
 */
export function expandImplied(capabilities: readonly AgentCapability[]): AgentCapability[] {
  const out = new Set<AgentCapability>();
  const walk = (c: AgentCapability) => {
    if (out.has(c)) return;
    out.add(c);
    for (const implied of CAPABILITY_SPECS[c].implies ?? []) walk(implied);
  };
  for (const c of capabilities) walk(c);
  return sortCapabilities([...out]);
}

/**
 * 稳定顺序 —— 按目录声明顺序，不按字母序。
 *
 * ★ 快照会落库、会被拿来比对两次 Run 的授权差异；顺序不稳定的话，
 *   每次派发都长得像「权限变了」。按目录顺序还有一个好处：
 *   界面上从低风险到高风险自然排列，不需要再排一次。
 */
export function sortCapabilities(capabilities: readonly AgentCapability[]): AgentCapability[] {
  const rank = new Map(AGENT_CAPABILITIES.map((c, i) => [c, i]));
  return [...new Set(capabilities)].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
}

/** 风险从高到低排序用 —— 影响预览要先说最重的那条 */
export const RISK_RANK: Record<CapabilityRisk, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};
