import type { DependencyType, RiskLevel, Stage, WorkItemStatus } from '@apos/contracts';

/**
 * 节点类型（页面文档 07 §5.1）。
 *
 * 七种类型形状各异 —— 不能只靠颜色区分，色觉障碍用户看不出橙色和红色的差别，
 * 但看得出菱形和矩形。
 */
export const NODE_KINDS = [
  'human_task',
  'agent_task',
  'approval',
  'automation',
  'waiting',
  'verification',
  'release',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export interface GraphNode {
  id: string;
  /** 人类可读编号（`ORD-19`）—— 图上要能指着一个节点说出它的名字 */
  ref: string;
  kind: NodeKind;
  title: string;
  type: string;
  status: WorkItemStatus;
  stage: Stage;
  riskLevel: RiskLevel;
  priority: number;
  executor: { type: string; id: string; name: string } | null;
  owner: { id: string; name: string } | null;
  /** 用于关键路径计算的工期（小时） */
  durationHours: number;
  /** 是否用了默认工期 —— 前端要能说明「这个数字是估的」 */
  durationEstimated: boolean;
  progressPct: number | null;
  tokens: number;
  runId: string | null;
  humanGateRef: string | null;
  decisionDueInMinutes: number | null;
  blockedSince: string | null;
  blockedReason: string | null;
  blockedMinutes: number | null;
  parentId: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: DependencyType;
  lagMinutes: number;
}

export interface GraphMetrics {
  /** 关键路径总时长（小时） */
  totalHours: number;
  /** 关键路径上尚未完成部分的时长 */
  remainingHours: number;
  /** 0–1 */
  delayRisk: number;
  /** ★ 归因 —— 本页价值的浓缩，直接告诉负责人该去解决什么 */
  primaryCause: string | null;
  /** 存在多条等长关键路径时全部标注 */
  criticalPaths: string[][];
}

export const DIAGNOSTIC_TYPES = [
  'cycle',
  'blocking_amplified',
  'pseudo_serial',
  'approval_bottleneck',
  'single_point',
  'agent_overload',
] as const;
export type DiagnosticType = (typeof DIAGNOSTIC_TYPES)[number];

export interface DiagnosticAction {
  /** 前端据此决定按钮行为 */
  kind: 'remind' | 'reassign' | 'split' | 'adjust_dependency' | 'adjust_policy' | 'locate';
  label: string;
  nodeId?: string;
  /** 伪串行诊断指向的那条边 */
  edge?: { from: string; to: string };
}

export interface Diagnostic {
  type: DiagnosticType;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  affectedNodes: string[];
  /** ★ 每条诊断必带可执行动作 —— 不做只诊断不给方案的提示（页面文档 07 §5.8） */
  actions: DiagnosticAction[];
}
