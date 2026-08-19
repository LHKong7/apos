import type {
  BlockedDetail,
  DependencyType,
  RiskLevel,
  Stage,
  WorkItemStatus,
} from '@apos/contracts';

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
  /** 结构化阻塞细节，供 tooltip 分层展示 */
  blockedDetail: BlockedDetail | null;
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

/**
 * 诊断动作的**说法**。
 *
 * ★★ 为什么和 `kind` 分开。
 *
 *   `kind` 是行为（点下去干什么），一个 kind 会有好几种说法：
 *   `reassign` 在阻塞诊断里叫「改派」、在审批瓶颈里叫「增加备用审批人」、
 *   在 Agent 过载里叫「分散到其他 Agent」。按 kind 取词会把三句话压成一句，
 *   而那三句正是用户判断「这个按钮会做什么」的全部依据。
 */
export type DiagnosticActionLabel =
  | 'expedite'
  | 'reassign'
  | 'locateOnBoard'
  | 'adjustPolicy'
  | 'addBackupApprover'
  | 'splitOffIndependentPart'
  | 'spreadAcrossAgents'
  | 'breakDependencyManually'
  | 'adjustDependency';

/** 诊断正文的词条码。与 DiagnosticType 不是一一对应：同一类诊断可有两种说法 */
export type DiagnosticMessageCode =
  | 'cycle'
  | 'blocking_amplified'
  | 'blocking_amplified_critical_path'
  | 'pseudo_serial'
  | 'approval_bottleneck'
  | 'single_point'
  | 'agent_overload';

export type DiagnosticParams = Record<string, string | number>;

export interface DiagnosticAction {
  /** 前端据此决定按钮行为 */
  kind: 'remind' | 'reassign' | 'split' | 'adjust_dependency' | 'adjust_policy' | 'locate';
  /** 按钮说法的词条码 —— 界面按它取词 */
  labelCode: DiagnosticActionLabel;
  /**
   * @deprecated 中文兜底句，给日志与存量客户端用 / Chinese fallback.
   *   界面一律走 labelCode；认不出码时才回落到这里。
   */
  label: string;
  nodeId?: string;
  /** 伪串行诊断指向的那条边 */
  edge?: { from: string; to: string };
}

/**
 * 一条图诊断。
 *
 * ★★ `messageCode` + `params` 是界面读的那份，`message` 是日志读的那份。
 *
 *   此前这里只有 `message` —— domain 层拼好的一句中文。它一路显示到
 *   执行图与总览上，于是英文界面上整段诊断是中文，而同一行里
 *   前端自己加的按钮是英文，两种语言并排：
 *
 *     「现状分析与方案调研」已阻塞 16.2h，下游 4 个任务在等，占关键路径 10%
 *     [ 改派 ] [ 在看板中定位 ] [ Locate in graph (5 nodes affected) ]
 *
 *   参数里只放语言中立的值（标题原文、数字、m/h/d 这类单位），
 *   任何需要变格变位的部分留给词条自己拼。
 *
 * The UI reads the code, logs read the sentence.
 */
export interface Diagnostic {
  type: DiagnosticType;
  severity: 'info' | 'warning' | 'critical';
  /** 界面按它取词 */
  messageCode: DiagnosticMessageCode;
  /** 词条里的 `{name}` 占位符对应的值 */
  params: DiagnosticParams;
  /**
   * @deprecated 中文兜底句，给日志与存量客户端用 / Chinese fallback.
   */
  message: string;
  affectedNodes: string[];
  /** ★ 每条诊断必带可执行动作 —— 不做只诊断不给方案的提示（页面文档 07 §5.8） */
  actions: DiagnosticAction[];
}
