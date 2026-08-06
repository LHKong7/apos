import { describe, expect, it } from 'vitest';
import { DependencyType } from '@apos/contracts';
import {
  evaluateGuards,
  isDependencyMet,
  type DependencyView,
  type GuardContext,
} from './guards.js';

function dep(overrides: Partial<DependencyView> = {}): DependencyView {
  return {
    fromId: 'wi-1',
    title: '前置任务',
    type: 'finish_to_start',
    fromStatus: 'done',
    fromActualStart: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function guardCtx(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    status: 'ready',
    targetStage: 'execution',
    dependencies: [],
    acceptanceCriteria: [],
    executorType: 'agent',
    executorId: '11111111-1111-1111-1111-111111111111',
    hasArtifact: true,
    hasOutputText: true,
    stageCount: 2,
    wipLimits: {},
    qualityGate: {
      testsPassed: true,
      securityScanPassed: true,
      criticalBugs: 0,
      coverage: 84,
      minCoverage: 80,
    },
    ...overrides,
  };
}

describe('isDependencyMet —— 七种依赖类型', () => {
  it('覆盖 DependencyType 的全部取值', () => {
    // 防止新增依赖类型时忘记实现判定逻辑
    const handled: DependencyView['type'][] = [
      'finish_to_start',
      'start_to_start',
      'artifact',
      'decision',
      'permission',
      'external',
      'data',
    ];
    expect(new Set(handled)).toEqual(new Set(DependencyType.options));
  });

  it('finish_to_start：前置完成才满足', () => {
    expect(isDependencyMet(dep({ fromStatus: 'done' }))).toBe(true);
    expect(isDependencyMet(dep({ fromStatus: 'released' }))).toBe(true);
    expect(isDependencyMet(dep({ fromStatus: 'acceptance' }))).toBe(true);
    expect(isDependencyMet(dep({ fromStatus: 'executing' }))).toBe(false);
    expect(isDependencyMet(dep({ fromStatus: 'reviewing' }))).toBe(false);
  });

  it('start_to_start：前置开始即满足', () => {
    expect(isDependencyMet(dep({ type: 'start_to_start', fromStatus: 'executing' }))).toBe(true);
    expect(
      isDependencyMet(dep({ type: 'start_to_start', fromStatus: 'ready', fromActualStart: null })),
    ).toBe(false);
  });

  it('artifact / decision / external / data 依赖各自的标志位', () => {
    expect(isDependencyMet(dep({ type: 'artifact', artifactPresent: true }))).toBe(true);
    expect(isDependencyMet(dep({ type: 'artifact', artifactPresent: false }))).toBe(false);
    expect(isDependencyMet(dep({ type: 'decision', decisionApproved: true }))).toBe(true);
    expect(isDependencyMet(dep({ type: 'external', externalReady: true }))).toBe(true);
    expect(isDependencyMet(dep({ type: 'data', dataReady: true }))).toBe(true);
  });

  it('★ permission 依赖让「权限不足」表现为阻塞而非反复失败', () => {
    expect(isDependencyMet(dep({ type: 'permission', permissionGranted: false }))).toBe(false);
    expect(isDependencyMet(dep({ type: 'permission', permissionGranted: true }))).toBe(true);
  });

  it('标志位缺失时视为未满足（保守）', () => {
    expect(isDependencyMet(dep({ type: 'artifact' }))).toBe(false);
    expect(isDependencyMet(dep({ type: 'decision' }))).toBe(false);
  });
});

describe('evaluateGuards', () => {
  it('全部通过时返回空数组', () => {
    const failures = evaluateGuards(
      ['dependenciesSatisfied', 'wipAvailable', 'executorAssigned'],
      guardCtx(),
    );
    expect(failures).toEqual([]);
  });

  it('依赖未满足时返回可读原因与明细', () => {
    const failures = evaluateGuards(
      ['dependenciesSatisfied'],
      guardCtx({ dependencies: [dep({ fromStatus: 'executing' }), dep({ fromStatus: 'blocked' })] }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBe('2 个前置依赖未满足');
    expect(failures[0]?.overridable).toBe(false);
    expect(failures[0]?.detail).toHaveLength(2);
  });

  it('WIP 超限可被 pm 强制放行', () => {
    const failures = evaluateGuards(
      ['wipAvailable'],
      guardCtx({ stageCount: 8, wipLimits: { execution: 8 } }),
    );
    expect(failures[0]?.reason).toContain('WIP 上限 8');
    expect(failures[0]?.overridable).toBe(true);
    expect(failures[0]?.overrideRole).toBe('pm');
  });

  it('未配置 WIP 限制时不拦截', () => {
    expect(evaluateGuards(['wipAvailable'], guardCtx({ stageCount: 999 }))).toEqual([]);
  });

  it('★ Agent 完成但零产出应被拦截', () => {
    const failures = evaluateGuards(
      ['hasOutput'],
      guardCtx({ hasArtifact: false, hasOutputText: false }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain('未产生任何产物');
  });

  it('验收标准未通过时列出具体项', () => {
    const failures = evaluateGuards(
      ['acceptanceCriteriaMet'],
      guardCtx({
        acceptanceCriteria: [
          { id: 'a', text: 'P95 < 500ms', verification: 'auto', status: 'pending', evidenceRef: null, verifiedAt: null },
          { id: 'b', text: '通过安全扫描', verification: 'auto', status: 'passed', evidenceRef: null, verifiedAt: null },
        ],
      }),
    );
    expect(failures[0]?.reason).toBe('1 项验收标准未通过');
    expect(failures[0]?.overrideRole).toBe('tech_lead');
  });

  it('质量门禁汇总所有失败项', () => {
    const failures = evaluateGuards(
      ['qualityGatePassed'],
      guardCtx({
        qualityGate: {
          testsPassed: false,
          securityScanPassed: false,
          criticalBugs: 2,
          coverage: 60,
          minCoverage: 80,
        },
      }),
    );
    expect(failures[0]?.detail).toHaveLength(4);
    expect(failures[0]?.reason).toContain('自动测试未通过');
    expect(failures[0]?.reason).toContain('2 个严重缺陷');
  });

  it('未配置覆盖率门槛时不因覆盖率失败', () => {
    const failures = evaluateGuards(
      ['qualityGatePassed'],
      guardCtx({
        qualityGate: {
          testsPassed: true,
          securityScanPassed: true,
          criticalBugs: 0,
          coverage: 10,
          minCoverage: null,
        },
      }),
    );
    expect(failures).toEqual([]);
  });

  it('override 跳过指定 guard', () => {
    const ctx = guardCtx({ stageCount: 8, wipLimits: { execution: 8 } });
    expect(evaluateGuards(['wipAvailable'], ctx)).toHaveLength(1);
    expect(evaluateGuards(['wipAvailable'], ctx, ['wipAvailable'])).toHaveLength(0);
  });

  it('未知 guard 抛异常而不是静默通过', () => {
    expect(() => evaluateGuards(['noSuchGuard'], guardCtx())).toThrow(/Unknown guard/);
  });
});
