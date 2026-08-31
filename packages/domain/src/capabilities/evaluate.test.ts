import { describe, expect, it } from 'vitest';
import { AGENT_CAPABILITIES, type AgentCapability, type CapabilityTranslator } from '@apos/contracts';
import { CAPABILITY_SPECS, expandImplied, PLATFORM_DENIED_CAPABILITIES } from './catalog';
import {
  accessModeOf,
  BUILTIN_CAPABILITY_PROFILES,
  CODE_DEVELOPER,
  expandProfile,
  FULL_PROJECT,
  READONLY_REVIEWER,
  STANDARD_EXECUTOR,
} from './profiles';
import { resolveEffectiveAgentAccess, type EffectiveAccessInput } from './evaluate';
import { capabilityChangeImpact } from './change-direction';

/** 什么都做得到、什么都不改写的翻译器 —— 只用来把运行时那一层从判定里摘掉 */
const passthrough: CapabilityTranslator = {
  kind: 'test',
  unsupported: [],
  translate: (input) => ({
    allowedTools: [...input.capabilities],
    deniedTools: [...input.deniedCapabilities],
    resourceScopes: [...input.resourceScopes],
    degradations: [],
  }),
};

function evaluate(overrides: Partial<EffectiveAccessInput> = {}) {
  return resolveEffectiveAgentAccess({
    projectGrant: null,
    projectResourceScopes: [],
    projectRepoRefs: [],
    agentCeiling: { allowedCapabilities: null, deniedCapabilities: [] },
    translator: passthrough,
    ...overrides,
  });
}

describe('能力档案展开', () => {
  /**
   * ★★ 展开必须确定：同样输入永远同样输出，顺序也一样。
   *   不确定的话每次保存都在审计里留一条「权限变了」，
   *   真正变了的那次就淹没在噪音里。
   */
  it('展开是确定性的，顺序稳定', () => {
    const a = expandProfile(STANDARD_EXECUTOR);
    const b = expandProfile(STANDARD_EXECUTOR);
    expect(a).toEqual(b);
    expect(a.allowedCapabilities).toEqual([...a.allowedCapabilities].sort(byCatalogOrder));
  });

  it('隐含能力被逐层展开到底', () => {
    // push → workspace.write → workspace.read
    expect(expandImplied(['repository.push'])).toContain('workspace.write');
    expect(expandImplied(['repository.push'])).toContain('workspace.read');
    // merge → pr.create → push → write → read
    expect(expandImplied(['pull_request.merge'])).toContain('workspace.read');
  });

  /**
   * ★★ 同一条能力既允许又拒绝时，拒绝赢。
   *   反过来的话，一条写着「禁止」的配置会放行 —— 那样的配置界面不能用。
   */
  it('拒绝压过允许，哪怕是显式加上去的', () => {
    const expanded = expandProfile(STANDARD_EXECUTOR, {
      add: ['repository.push'],
      remove: ['repository.push'],
    });
    expect(expanded.allowedCapabilities).not.toContain('repository.push');
    expect(expanded.deniedCapabilities).toContain('repository.push');
  });

  it('每个内置档案的允许与拒绝不交叠', () => {
    for (const profile of BUILTIN_CAPABILITY_PROFILES) {
      const expanded = expandProfile(profile);
      const denied = new Set(expanded.deniedCapabilities);
      expect(expanded.allowedCapabilities.filter((c) => denied.has(c))).toEqual([]);
    }
  });
});

describe('★ 安全底线', () => {
  /**
   * ★★ 阻断性测试，与 policy/evaluate.test.ts 里那一组同一性质。
   *   它红了说明「Agent 不能改自己的约束」这条被绕过了 —— 那之后
   *   整套治理体系只是装饰。
   */
  it('改权限与改 Policy 的能力任何配置都授不出去', () => {
    for (const capability of ['permission.manage', 'policy.manage'] as AgentCapability[]) {
      const access = evaluate({
        projectGrant: {
          profileKey: 'custom',
          profileVersion: 1,
          allowedCapabilities: [capability],
          deniedCapabilities: [],
        },
        agentCeiling: { allowedCapabilities: null, deniedCapabilities: [] },
      });

      expect(access.capabilities).not.toContain(capability);
      expect(access.sources).toContainEqual({
        capability,
        source: 'platform_baseline',
        denied: true,
      });
    }
  });

  it('平台底线清单与目录里的 neverAutoGrant 一致', () => {
    const fromCatalog = AGENT_CAPABILITIES.filter((c) => CAPABILITY_SPECS[c].neverAutoGrant);
    expect([...PLATFORM_DENIED_CAPABILITIES]).toEqual([...fromCatalog]);
  });

  /**
   * ★★ 默认档案的边界 —— 「零配置接入」把它从 standard_executor 挪到了
   *   full_project，所以这条断言比以前更要紧。
   *
   *   放宽的那一半是刻意的：项目里的活它都能干（改工作区、构建、测试、
   *   交产物、推分支、开 PR）。不放的那一半才是这条测试要钉住的 ——
   *   合并、部署、写库、读凭证、改权限、改治理，一条都不给。
   *   这六条正是「代替人做最后那一下」和「平台控制面」，而它们要是哪天
   *   悄悄进了默认档案，症状是**没有症状**：所有人的 Agent 一起变宽，
   *   而没有任何一次配置变更留下痕迹。
   */
  it('★ 默认 Agent 干得了项目里的活，但合不了、发不了、写不了库、读不到凭证、改不了治理', () => {
    const access = evaluate();

    expect(access.profileKey).toBe(FULL_PROJECT.key);
    expect(accessModeOf(access.profileKey)).toBe('full_project');

    for (const granted of [
      'workspace.read',
      'workspace.write',
      'command.build',
      'command.test',
      'artifact.create',
      'repository.push',
      'pull_request.create',
    ] as AgentCapability[]) {
      expect(access.capabilities, granted).toContain(granted);
    }

    for (const forbidden of [
      'pull_request.merge',
      'environment.deploy',
      'database.write',
      'secret.read',
      'permission.manage',
      'policy.manage',
    ] as AgentCapability[]) {
      expect(access.capabilities, forbidden).not.toContain(forbidden);
    }
  });

  /**
   * ★★ 上一条列的是**今天**的清单，这一条钉的是**规则**：默认档案里
   *   永远不出现 `critical` 这一档。
   *
   *   两条都要有。只写清单的话，往目录里加一条新的 critical 能力时，
   *   谁也不会想起回来改这个数组 —— 而按规则判的这一条会当场红。
   */
  it('★ 默认档案里不含任何 critical 能力 —— 新加一条也自动落在外面', () => {
    const access = evaluate();
    const critical = access.capabilities.filter((c) => CAPABILITY_SPECS[c].risk === 'critical');
    expect(critical).toEqual([]);
  });

  /** ★ 收窄仍然做得到：Restrict access 之后，默认那份就不作数了 */
  it('★ 选了更窄的档案之后，访问模式记为 restricted', () => {
    const access = evaluate({ projectGrant: expandProfile(STANDARD_EXECUTOR) });
    expect(access.profileKey).toBe(STANDARD_EXECUTOR.key);
    expect(accessModeOf(access.profileKey)).toBe('restricted');
    expect(access.capabilities).toContain('workspace.write');
    expect(access.capabilities).not.toContain('repository.push');
  });

  it('没有任何配置时也不是「没权限」，而是默认档案', () => {
    const access = evaluate();
    expect(access.capabilities.length).toBeGreaterThan(0);
    expect(access.sources.filter((s) => !s.denied).every((s) => s.source === 'project_default')).toBe(
      true,
    );
  });
});

describe('★ 上限与项目隔离', () => {
  /**
   * ★★ 项目授予不得超过组织给这个 Agent 的上限。
   *   没有这条的话，谁能建项目谁就能给任意 Agent 任意权限。
   */
  it('项目授予超不过 Agent 能力上限', () => {
    const access = evaluate({
      projectGrant: expandProfile(CODE_DEVELOPER),
      agentCeiling: {
        allowedCapabilities: ['workspace.read', 'workspace.write', 'command.test'],
        deniedCapabilities: [],
      },
    });

    expect(access.capabilities).not.toContain('repository.push');
    expect(access.sources).toContainEqual({
      capability: 'repository.push',
      source: 'agent_ceiling',
      denied: true,
    });
  });

  it('上限里的硬拒绝压过项目档案的允许', () => {
    const access = evaluate({
      projectGrant: expandProfile(CODE_DEVELOPER),
      agentCeiling: { allowedCapabilities: null, deniedCapabilities: ['repository.push'] },
    });
    expect(access.capabilities).not.toContain('repository.push');
  });

  /**
   * ★★ 同一个 Agent 在两个项目里可以是两套权限，而且互不影响。
   *   这是整个 project_agent_permissions 存在的理由 —— 求值只看传进来的
   *   那一份项目授予，没有任何跨项目的输入。
   */
  it('A 项目的授予不会渗进 B 项目', () => {
    const inA = evaluate({ projectGrant: expandProfile(CODE_DEVELOPER) });
    const inB = evaluate({ projectGrant: expandProfile(READONLY_REVIEWER) });

    expect(inA.capabilities).toContain('repository.push');
    expect(inB.capabilities).not.toContain('repository.push');
    expect(inB.capabilities).not.toContain('workspace.write');
  });

  /**
   * ★ 资源范围跟着能力收窄。
   *   只读档案配上一条可写仓库是自相矛盾的两句话，而运行时只看得到后者。
   */
  it('只读档案下，可写仓库范围被降到只读', () => {
    const access = evaluate({
      projectGrant: expandProfile(READONLY_REVIEWER),
      projectResourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'write' }],
    });

    const repo = access.runtimePermissions.resourceScopes.find((s) => s.ref === 'order-service');
    expect(repo?.access).toBe('read');
  });

  /**
   * ★★ 平台默认给的那一档**跟着能力走**，两个方向都走。
   *
   *   它以前恒定是 read，于是一个零配置建出来的 Agent（默认档案含
   *   workspace.write）拿到的是只读工作区 —— 有能力改，却在一个改不动的
   *   目录里开工，而失败发生在它已经跑起来之后，报出来的是「未找到相关代码」。
   *
   *   出处那一栏照旧标 project_default：审计要分得出「管理员授了权」
   *   和「平台默认给的」，这一条不因为档位变了而模糊。
   */
  it('★ 默认档案下，项目级仓库默认档位升到可写，出处仍标平台默认', () => {
    const access = evaluate({ projectRepoRefs: ['order-service'] });
    const repo = access.runtimePermissions.resourceScopes.find((s) => s.ref === 'order-service');
    expect(repo).toMatchObject({ access: 'write', origin: 'project_default' });
  });

  it('★ 只读档案下，同一条默认范围留在只读', () => {
    const access = evaluate({
      projectGrant: expandProfile(READONLY_REVIEWER),
      projectRepoRefs: ['order-service'],
    });
    const repo = access.runtimePermissions.resourceScopes.find((s) => s.ref === 'order-service');
    expect(repo).toMatchObject({ access: 'read', origin: 'project_default' });
  });

  /**
   * ★★ 管理员**显式**写的那些一个字不动 —— 升档只对平台默认那一档。
   *
   *   显式写着 read 是有人做过的决定（「这个仓库它只能看」），
   *   而能力那一侧不该替他把这个决定撤销掉。
   */
  it('★ 显式配成只读的仓库不会被升成可写', () => {
    const access = evaluate({
      projectResourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'read' }],
      projectRepoRefs: ['order-service'],
    });
    const repo = access.runtimePermissions.resourceScopes.find((s) => s.ref === 'order-service');
    expect(repo).toMatchObject({ access: 'read', origin: 'explicit' });
  });
});

describe('★ 运行时降级', () => {
  const cannotWrite: CapabilityTranslator = {
    kind: 'toy',
    unsupported: ['workspace.write'],
    translate: () => ({
      allowedTools: [],
      deniedTools: [],
      resourceScopes: [],
      degradations: [],
    }),
  };

  /**
   * ★★ 运行时做不到的能力要被交集掉，**并且说出来**。
   *   静默忽略的话，界面上那条授权和别处长得一模一样，
   *   而用户以为配好了。
   */
  it('运行时做不到的能力被拿掉并报出降级', () => {
    const access = resolveEffectiveAgentAccess({
      projectGrant: null,
      projectResourceScopes: [],
      projectRepoRefs: [],
      agentCeiling: { allowedCapabilities: null, deniedCapabilities: [] },
      translator: cannotWrite,
    });

    expect(access.capabilities).not.toContain('workspace.write');
    expect(access.sources).toContainEqual({
      capability: 'workspace.write',
      source: 'runtime_unsupported',
      denied: true,
    });
    expect(access.warnings.join(' ')).toContain('toy');
  });

  /**
   * ★ 拿不到运行时时**不做**运行时交集，而不是把所有能力判成不支持。
   *   恢复策略够不到进程里的注册表，在那里把 Agent 判成什么都做不了，
   *   会让「有没有替补」这个问题永远答否。
   */
  it('没有翻译器时不做运行时收窄', () => {
    const access = evaluate({ translator: null });
    expect(access.capabilities).toContain('workspace.write');
    expect(access.degradations).toEqual([]);
  });
});

describe('★ 改动方向', () => {
  const setOf = (profileKey: 'standard' | 'developer' | 'reviewer') => {
    const profile =
      profileKey === 'developer'
        ? CODE_DEVELOPER
        : profileKey === 'reviewer'
          ? READONLY_REVIEWER
          : STANDARD_EXECUTOR;
    const expanded = expandProfile(profile);
    return {
      capabilities: expanded.allowedCapabilities,
      deniedCapabilities: expanded.deniedCapabilities,
      resourceScopes: [],
    };
  };

  it('加能力判为放宽，并要求填原因', () => {
    const impact = capabilityChangeImpact(setOf('standard'), setOf('developer'));
    expect(impact.direction).toBe('loosen');
    expect(impact.addedCapabilities).toContain('repository.push');
    expect(impact.requiresReason).toBe(true);
    expect(impact.warnings[0]).toContain('远端');
  });

  it('减能力判为收紧，不强制填原因', () => {
    const impact = capabilityChangeImpact(setOf('developer'), setOf('reviewer'));
    expect(impact.direction).toBe('tighten');
    expect(impact.removedCapabilities).toContain('repository.push');
    expect(impact.requiresReason).toBe(false);
  });

  it('没变化时判为中性', () => {
    expect(capabilityChangeImpact(setOf('standard'), setOf('standard')).direction).toBe('neutral');
  });

  /**
   * ★★ 混合改动按放宽那一面判 —— 与 Policy 那边同一条规则。
   *   放宽的那一面才是需要额外证据的部分。
   */
  it('一边加一边减时按放宽判', () => {
    const before = {
      capabilities: ['workspace.read', 'workspace.write'] as AgentCapability[],
      deniedCapabilities: [] as AgentCapability[],
      resourceScopes: [],
    };
    const after = {
      capabilities: ['workspace.read', 'repository.push'] as AgentCapability[],
      deniedCapabilities: [] as AgentCapability[],
      resourceScopes: [],
    };
    expect(capabilityChangeImpact(before, after).direction).toBe('loosen');
  });

  /** ★ 资源访问级别升级也是放宽，哪怕能力集合一条没变 */
  it('仓库从只读升到可写判为放宽', () => {
    const base = {
      capabilities: ['workspace.read', 'workspace.write'] as AgentCapability[],
      deniedCapabilities: [] as AgentCapability[],
    };
    const impact = capabilityChangeImpact(
      { ...base, resourceScopes: [{ kind: 'repo', ref: 'api', access: 'read' }] },
      { ...base, resourceScopes: [{ kind: 'repo', ref: 'api', access: 'write' }] },
    );
    expect(impact.direction).toBe('loosen');
    expect(impact.affectedResources).toEqual(['api']);
  });
});

function byCatalogOrder(a: AgentCapability, b: AgentCapability): number {
  return AGENT_CAPABILITIES.indexOf(a) - AGENT_CAPABILITIES.indexOf(b);
}
