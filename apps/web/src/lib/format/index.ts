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

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  clarifying: '澄清中',
  awaiting_requirement_approval: '待需求确认',
  planning: '规划中',
  awaiting_plan_approval: '待计划批准',
  ready: '待执行',
  executing: '执行中',
  blocked: '阻塞',
  failed: '失败',
  reviewing: '审核中',
  changes_requested: '需返工',
  awaiting_decision: '待决策',
  waiting_for_release: '等待发布',
  releasing: '发布中',
  released: '已发布',
  acceptance: '验收中',
  done: '已完成',
  cancelled: '已取消',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
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
