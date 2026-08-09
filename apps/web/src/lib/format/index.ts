import { STATUS_LABELS, type WorkItemStatus } from '@apos/contracts';

/** 成本统一两位小数并带 $ —— 看板上要能一眼横向比较 */
export function money(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toFixed(2)}`;
}

/**
 * 时长。
 *
 * 刻意只保留两级（3h20m 而不是 3h20m15s）：
 * 卡片上的时长是用来判断「久不久」的，秒级精度只会占地方。
 */
export function duration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  const abs = Math.abs(Math.round(minutes));
  if (abs < 60) return `${abs}m`;
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h < 24) return m === 0 ? `${h}h` : `${h}h${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

/** 决策时限：超时用负数表达，展示成「超时 2h」 */
export function deadline(minutes: number | null | undefined): {
  text: string;
  overdue: boolean;
} {
  if (minutes === null || minutes === undefined) return { text: '', overdue: false };
  if (minutes < 0) return { text: `超时 ${duration(minutes)}`, overdue: true };
  return { text: `${duration(minutes)} 内`, overdue: false };
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return '刚刚';
  return `${duration(diff / 60_000)}前`;
}

const TYPE_ICONS: Record<string, string> = {
  requirement: '📋',
  feature: '✨',
  story: '📖',
  task: '🔧',
  bug: '🐞',
  research: '🔍',
  review: '👁',
  test: '🧪',
  incident: '🚨',
  decision: '⚖️',
  approval: '✅',
  release: '🚀',
  knowledge: '📚',
};

export function typeIcon(type: string): string {
  return TYPE_ICONS[type] ?? '🔧';
}

/** 事件来源图标（页面文档 05 §5.5 的移动来源标注） */
const SOURCE_ICONS: Record<string, string> = {
  system: '🔧',
  agent: '🤖',
  human: '👤',
  external: '🔗',
  service: '⚙️',
};

export function sourceIcon(actorType: string): string {
  return SOURCE_ICONS[actorType] ?? '🔧';
}

export function sourceLabel(actorType: string): string {
  const labels: Record<string, string> = {
    system: '系统自动',
    agent: 'Agent 推动',
    human: '人工调整',
    external: '外部集成',
    service: '服务触发',
  };
  return labels[actorType] ?? actorType;
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as WorkItemStatus] ?? status;
}

const RISK_LABELS: Record<string, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  critical: '极高风险',
};

export function riskLabel(risk: string): string {
  return RISK_LABELS[risk] ?? risk;
}

/** 看板列名。与后端的 Stage 一一对应，全站只此一份。 */
const STAGE_NAMES: Record<string, string> = {
  intake: 'Intake',
  planning: 'Planning',
  execution: 'Execution',
  review: 'Review',
  release: 'Release',
  done: 'Done',
};

export function stageLabel(stage: string): string {
  return STAGE_NAMES[stage] ?? stage;
}

/**
 * 领域事件的中文名。
 *
 * ★ 事件类型是给系统看的（work_item.status_changed），
 *   活动流是给项目负责人看的。总览页上那条「最近活动」如果直接印事件键，
 *   它就从「项目在发生什么」退化成一段日志 —— 而看日志不是负责人的工作。
 *
 * ★ 兜底不译回 key，而是按前缀给个粗粒度的说法：
 *   将来新增事件类型时，页面上出现的是「任务变更」而不是一串下划线。
 */
const EVENT_LABELS: Record<string, string> = {
  'project.created': '项目创建',
  'project.autonomy_changed': '自治级别变更',
  'project.paused': '项目暂停',
  'project.resumed': '项目恢复',
  'project.budget_threshold_reached': '预算触线',
  'project.completed': '项目完成',
  'requirement.created': '需求录入',
  'requirement.analyzed': '需求分析完成',
  'requirement.clarification_answered': '澄清已回答',
  'requirement.field_edited': '需求字段修改',
  'requirement.approved': '需求确认',
  'requirement.rejected': '需求驳回',
  'requirement.assumption_invalidated': '假设被推翻',
  'plan.generated': '计划生成',
  'plan.item_modified': '计划调整',
  'plan.approved': '计划确认',
  'plan.revision_requested': '计划要求修改',
  'plan.superseded': '计划被替换',
  'work_item.created': '任务创建',
  'work_item.status_changed': '任务状态变更',
  'work_item.assigned': '任务分派',
  'work_item.blocked': '任务被阻塞',
  'work_item.unblocked': '阻塞解除',
  'work_item.taken_over': '人接管任务',
  'work_item.handed_back': '任务交回 Agent',
  'work_item.acceptance_updated': '验收标准更新',
  'work_item.force_passed': '强制通过验收',
  'work_item.dependency_added': '新增依赖',
  'work_item.dependency_removed': '移除依赖',
  'work_item.split': '任务拆分',
  'work_item.merged': '任务合并',
  'agent_run.dispatched': 'Agent 派发',
  'agent_run.started': 'Agent 开始执行',
  'agent_run.completed': 'Agent 执行完成',
  'agent_run.failed': 'Agent 执行失败',
  'agent_run.timeout': 'Agent 执行超时',
  'agent_run.terminated': '执行被终止',
  'agent_run.heartbeat_lost': '心跳丢失',
  'agent_run.constraint_added': '追加执行约束',
  'agent_run.cost_threshold_reached': '成本触线',
  'decision.created': '决策待处理',
  'decision.approved': '决策批准',
  'decision.rejected': '决策驳回',
  'decision.revision_requested': '决策要求修改',
  'decision.delegated': '决策改派',
  'decision.escalated': '决策升级',
  'decision.reminded': '决策催办',
  'decision.expired': '决策超时',
  'decision.outcome_recorded': '决策结果回填',
  'policy.evaluated': 'Policy 评估',
  'policy.created': 'Policy 新增',
  'policy.updated': 'Policy 修改',
  'policy.disabled': 'Policy 停用',
  'agent.registered': 'Agent 注册',
  'agent.permissions_changed': 'Agent 权限变更',
  'agent.permission_violation': 'Agent 越权',
  'agent.paused': 'Agent 暂停',
  'artifact.produced': '产出交付物',
  'integration.connected': '集成接入',
  'integration.disconnected': '集成断开',
  'integration.synced': '集成同步',
  'integration.conflict_detected': '同步冲突',
  'integration.conflict_resolved': '冲突已解决',
  'integration.error': '集成异常',
};

const EVENT_PREFIX_LABELS: Record<string, string> = {
  project: '项目变更',
  requirement: '需求变更',
  plan: '计划变更',
  work_item: '任务变更',
  agent_run: 'Agent 执行',
  decision: '决策',
  policy: 'Policy 变更',
  agent: 'Agent 变更',
  artifact: '交付物',
  integration: '集成',
};

export function eventLabel(type: string): string {
  const known = EVENT_LABELS[type];
  if (known) return known;
  return EVENT_PREFIX_LABELS[type.split('.')[0] ?? ''] ?? type;
}
