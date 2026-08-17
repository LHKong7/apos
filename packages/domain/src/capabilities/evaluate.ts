import type {
  AgentCapability,
  CapabilityDegradation,
  CapabilityTranslator,
  PermissionSource,
  ResourceScope,
} from '@apos/contracts';
import { effectiveResourceScopes } from '../permissions/resource-scopes';
import { CAPABILITY_SPECS, PLATFORM_DENIED_CAPABILITIES, sortCapabilities } from './catalog';
import { defaultExpandedProfile, type ExpandedProfile } from './profiles';

/**
 * 生效权限求值 —— 「这个 Agent 在这个项目里，此刻到底能做什么」。
 *
 * ★★ 唯一的一份判定。调度器选候选、派发前冻结快照、界面显示「生效权限」、
 *   保存前的影响预览，四处全走这里。
 *
 *   分成两份实现的代价不是重复代码，是**两个都对不上的答案**：调度器认为
 *   某个 Agent 不合格而不派它，运行时却认为它权限齐全；或者反过来 ——
 *   预览说「不会有变化」，保存之后权限变了。这类偏差极难复现，因为它只在
 *   两份实现出现分歧的那些输入上出现。
 *
 * 求值顺序（任一层拒绝即拒绝）：
 * ```
 * 平台安全基线
 *   ∩ 组织给这个 Agent 的能力上限
 *   ∩ 项目里的能力授予
 *   ∩ 运行时真正做得到的
 *   + 项目资源范围
 * ```
 *
 * ★ 显式拒绝**永远**压过允许，无论它出现在哪一层。这条不是优化，
 *   是这套模型能不能被信任的前提：一个写着「禁止合并」的配置，
 *   不该因为上游某处给了 merge 就放行。
 *
 * The single authority on what an Agent may do in a project. Matching,
 * dispatch, the effective-access panel and the pre-save preview all call it,
 * because two implementations do not merely duplicate code — they produce two
 * answers that disagree only on the inputs where they differ, which is exactly
 * where nobody is looking. Any explicit denial beats any allow, at every layer.
 */

export interface AgentCeiling {
  /**
   * 组织给这个 Agent 定的能力上限。
   *
   * ★ null = 不设上限（沿用平台基线）。空数组是「一条都不给」，
   *   两者含义相反 —— 用 undefined/null 表达「没设置」是这里唯一安全的写法。
   */
  allowedCapabilities: readonly AgentCapability[] | null;
  deniedCapabilities: readonly AgentCapability[];
}

export interface EffectiveAccessInput {
  /** 项目里这个 Agent 的能力授予；null = 没配过，用默认档案 */
  projectGrant: ExpandedProfile | null;
  /** 项目里显式配的资源范围 */
  projectResourceScopes: readonly ResourceScope[];
  /** 本项目**项目级**登记且启用的仓库 ref —— 它们默认只读 */
  projectRepoRefs: readonly string[];
  agentCeiling: AgentCeiling;
  /**
   * 运行时翻译器；null = 拿不到运行时（未注册 / 纯判定场景）。
   *
   * ★ 拿不到时不做运行时交集，而不是把所有能力当成不支持：
   *   恢复策略与部分测试够不到进程里的注册表，在那里把 Agent 判成
   *   「什么都做不了」会让「有没有替补」这个问题永远答否。
   */
  translator: CapabilityTranslator | null;
  runtimeManifest?: unknown;
}

export interface EffectiveAgentAccess {
  capabilities: AgentCapability[];
  deniedCapabilities: AgentCapability[];

  runtimePermissions: {
    allowedTools: string[];
    deniedTools: string[];
    resourceScopes: ResourceScope[];
  };

  profileKey: string;
  profileVersion: number;

  /** 每条能力的出处；被拿掉的那些 denied=true，并带上是哪一层拿掉的 */
  sources: PermissionSource[];
  degradations: CapabilityDegradation[];
  /** 已渲染成人话的警告，界面直接显示 */
  warnings: string[];
}

export function resolveEffectiveAgentAccess(input: EffectiveAccessInput): EffectiveAgentAccess {
  const grant = input.projectGrant ?? defaultExpandedProfile();
  const sources: PermissionSource[] = [];
  const degradations: CapabilityDegradation[] = [];

  /**
   * ★ 起点是项目授予，不是「所有能力」。默认拒绝是这套模型的基线
   *   （docs/tech/09-security.md §3.1）：没被授予的能力压根不进入候选集，
   *   于是「漏了一条判定」的后果是少给权限，不是多给。
   */
  const candidates = sortCapabilities(grant.allowedCapabilities);

  const deniedBy = new Map<AgentCapability, PermissionSource['source']>();

  /** 层层收窄。每一层只**拿掉**能力，永远不加 —— 交集语义靠这条保证 */
  const denyFrom = (caps: readonly AgentCapability[], source: PermissionSource['source']) => {
    for (const c of caps) if (!deniedBy.has(c)) deniedBy.set(c, source);
  };

  // ① 平台安全底线：任何配置都放不开
  denyFrom(PLATFORM_DENIED_CAPABILITIES, 'platform_baseline');
  // ② 组织给这个 Agent 的硬拒绝
  denyFrom(input.agentCeiling.deniedCapabilities, 'agent_ceiling');
  // ③ 项目档案自带的拒绝
  denyFrom(grant.deniedCapabilities, 'project_profile');

  /**
   * ④ 能力上限：不在上限里的一律拿掉。
   *
   * ★★ 这一层是「项目授予不得超过 Agent 上限」的落点，也是多项目隔离的
   *   另一半 —— 项目管理员能在自己项目里选档案，但选不出组织没给这个
   *   Agent 的能力。没有它的话，谁能建项目谁就能给任意 Agent 任意权限。
   */
  if (input.agentCeiling.allowedCapabilities !== null) {
    const ceiling = new Set(input.agentCeiling.allowedCapabilities);
    denyFrom(
      candidates.filter((c) => !ceiling.has(c)),
      'agent_ceiling',
    );
  }

  // ⑤ 运行时做不到的
  if (input.translator) {
    const unsupported = candidates.filter((c) => input.translator!.unsupported.includes(c));
    denyFrom(unsupported, 'runtime_unsupported');
    for (const c of unsupported) {
      degradations.push({
        capability: c,
        kind: 'unavailable',
        detail: `运行时 ${input.translator.kind} 不具备「${CAPABILITY_SPECS[c].label}」，该授权在这个 Agent 上不会生效`,
      });
    }
  }

  const effective = candidates.filter((c) => !deniedBy.has(c));

  for (const c of effective) {
    sources.push({
      capability: c,
      source: input.projectGrant ? 'project_profile' : 'project_default',
      denied: false,
    });
  }
  for (const [capability, source] of deniedBy) {
    sources.push({ capability, source, denied: true });
  }

  /**
   * 资源范围：项目里显式配的 + 项目级仓库的默认只读。
   *
   * ★ 复用 effectiveResourceScopes，不另写一份 —— 「项目仓库默认只读」
   *   这条规则已经有了唯一实现，再写一遍就是再造一次分歧。
   */
  const scopes = effectiveResourceScopes({
    explicit: input.projectResourceScopes,
    projectRepoRefs: input.projectRepoRefs,
  });

  /**
   * ★★ 资源范围要**跟着能力收窄**。
   *
   *   一个只读档案配上一条 `access:'write'` 的仓库范围，是配置层面
   *   自相矛盾的两句话，而运行时只看得到后者 —— 于是「只读评审者」
   *   会拿到一个可写工作区。让能力这一侧说了算：没有 workspace.write，
   *   任何仓库范围都降到 read。
   */
  const canWriteWorkspace = effective.includes('workspace.write');
  const alignedScopes = scopes.map((s) =>
    s.kind === 'repo' && s.access === 'write' && !canWriteWorkspace
      ? { ...s, access: 'read' as const }
      : s,
  );

  const translation = input.translator
    ? input.translator.translate({
        capabilities: effective,
        deniedCapabilities: sortCapabilities([...deniedBy.keys()]),
        resourceScopes: alignedScopes,
        runtimeManifest: input.runtimeManifest,
      })
    : {
        allowedTools: [],
        deniedTools: [],
        resourceScopes: [...alignedScopes],
        degradations: [],
      };

  degradations.push(...translation.degradations);

  return {
    capabilities: effective,
    deniedCapabilities: sortCapabilities([...deniedBy.keys()]),
    runtimePermissions: {
      allowedTools: translation.allowedTools,
      deniedTools: translation.deniedTools,
      resourceScopes: translation.resourceScopes,
    },
    profileKey: grant.profileKey,
    profileVersion: grant.profileVersion,
    sources,
    degradations,
    warnings: degradations.map((d) => d.detail),
  };
}
