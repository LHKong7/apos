import type { AcceptanceCriterion, DependencyType, WorkItemStatus } from '@apos/contracts';

/**
 * Guard 是纯函数。失败原因要能直接展示给用户 ——
 * 页面文档 05 §5.6 要求拖拽到非法列时说明原因。
 */
export interface GuardFailure {
  guard: string;
  reason: string;
  detail?: unknown;
  /** 是否可被人类强制放行（页面文档 06 §5.4） */
  overridable: boolean;
  /** 强制放行所需角色 */
  overrideRole?: string;
}

export type GuardResult = { ok: true } | ({ ok: false } & Omit<GuardFailure, 'guard'>);

export interface DependencyView {
  fromId: string;
  title: string;
  type: DependencyType;
  fromStatus: WorkItemStatus;
  fromActualStart: string | null;
  /** artifact 依赖：所需产物是否已存在 */
  artifactPresent?: boolean;
  /** decision 依赖：决策是否已批准 */
  decisionApproved?: boolean;
  /** permission 依赖：执行主体是否具备所需权限 */
  permissionGranted?: boolean;
  /** external 依赖：外部系统是否就绪 */
  externalReady?: boolean;
  /** data 依赖：数据是否准备好 */
  dataReady?: boolean;
}

export interface GuardContext {
  status: WorkItemStatus;
  /** 任务当前所在阶段 —— 与 targetStage 相同表示这次流转不跨列 */
  currentStage: string;
  targetStage: string;
  dependencies: DependencyView[];
  acceptanceCriteria: AcceptanceCriterion[];
  executorType: string | null;
  executorId: string | null;
  hasArtifact: boolean;
  hasOutputText: boolean;
  /** 目标阶段当前的在制品数 */
  stageCount: number;
  wipLimits: Record<string, number | undefined>;
  qualityGate: {
    testsPassed: boolean;
    securityScanPassed: boolean;
    criticalBugs: number;
    coverage: number | null;
    minCoverage: number | null;
  };
}

const DONE_STATUSES: readonly WorkItemStatus[] = ['done', 'released', 'acceptance'];

/** 依赖满足判定 —— 七种类型（产品文档 8.6.2） */
export function isDependencyMet(dep: DependencyView): boolean {
  switch (dep.type) {
    case 'finish_to_start':
      return DONE_STATUSES.includes(dep.fromStatus);
    case 'start_to_start':
      return dep.fromActualStart !== null;
    case 'artifact':
      return dep.artifactPresent === true;
    case 'decision':
      return dep.decisionApproved === true;
    case 'permission':
      return dep.permissionGranted === true;
    case 'external':
      return dep.externalReady === true;
    case 'data':
      return dep.dataReady === true;
  }
}

export type Guard = (ctx: GuardContext) => GuardResult;

export const GUARDS: Record<string, Guard> = {
  dependenciesSatisfied(ctx) {
    const unmet = ctx.dependencies.filter((d) => !isDependencyMet(d));
    if (unmet.length === 0) return { ok: true };
    return {
      ok: false,
      reason: `${unmet.length} 个前置依赖未满足`,
      detail: unmet.map((d) => ({
        id: d.fromId,
        title: d.title,
        type: d.type,
        status: d.fromStatus,
      })),
      overridable: false,
    };
  },

  wipAvailable(ctx) {
    /**
     * ★ WIP 限制管的是「进入这一列」，不是「在这一列里前进」。
     *
     * ready → executing 就发生在 Execution 列内部，列的占用数根本没变。
     * 不区分这一点会死锁：计划批准后所有任务都落在 Execution 列的 ready，
     * 一旦数量超过上限，就再没有任务能开始执行，而看板上明明一个都没在跑。
     */
    if (ctx.currentStage === ctx.targetStage) return { ok: true };

    const limit = ctx.wipLimits[ctx.targetStage];
    if (limit === undefined) return { ok: true };
    if (ctx.stageCount < limit) return { ok: true };
    return {
      ok: false,
      reason: `${ctx.targetStage} 阶段已达 WIP 上限 ${limit}`,
      detail: { limit, current: ctx.stageCount },
      overridable: true,
      overrideRole: 'pm',
    };
  },

  executorAssigned(ctx) {
    if (ctx.executorType && ctx.executorId) return { ok: true };
    return { ok: false, reason: '尚未分配执行主体', overridable: false };
  },

  /** Agent 完成但没有任何产出，说明它其实什么都没做 */
  hasOutput(ctx) {
    if (ctx.hasArtifact || ctx.hasOutputText) return { ok: true };
    return {
      ok: false,
      reason: 'Agent 执行完成但未产生任何产物或输出',
      overridable: true,
      overrideRole: 'tech_lead',
    };
  },

  acceptanceCriteriaMet(ctx) {
    const unmet = ctx.acceptanceCriteria.filter((c) => c.status !== 'passed');
    if (unmet.length === 0) return { ok: true };
    return {
      ok: false,
      reason: `${unmet.length} 项验收标准未通过`,
      detail: unmet.map((c) => ({ id: c.id, text: c.text, status: c.status })),
      overridable: true,
      overrideRole: 'tech_lead',
    };
  },

  /** 质量门禁（产品文档 8.10.3）：未满足不允许进入 Release */
  qualityGatePassed(ctx) {
    const q = ctx.qualityGate;
    const failures: string[] = [];
    if (!q.testsPassed) failures.push('自动测试未通过');
    if (!q.securityScanPassed) failures.push('安全扫描未通过');
    if (q.criticalBugs > 0) failures.push(`存在 ${q.criticalBugs} 个严重缺陷`);
    if (q.minCoverage !== null && q.coverage !== null && q.coverage < q.minCoverage) {
      failures.push(`测试覆盖率 ${q.coverage}% 低于门槛 ${q.minCoverage}%`);
    }
    if (failures.length === 0) return { ok: true };
    return {
      ok: false,
      reason: `质量门禁未通过：${failures.join('、')}`,
      detail: failures,
      overridable: true,
      overrideRole: 'tech_lead',
    };
  },
};

export function evaluateGuards(
  names: string[],
  ctx: GuardContext,
  overrides: string[] = [],
): GuardFailure[] {
  const failures: GuardFailure[] = [];
  for (const name of names) {
    if (overrides.includes(name)) continue;
    const guard = GUARDS[name];
    if (!guard) throw new Error(`Unknown guard: ${name}`);
    const result = guard(ctx);
    if (!result.ok) failures.push({ guard: name, ...result });
  }
  return failures;
}
