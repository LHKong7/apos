import { t, type MessageKey } from '../i18n';

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
  if (minutes < 0) {
    return { text: t('format.deadline.overdue', { time: duration(minutes) }), overdue: true };
  }
  return { text: t('format.deadline.within', { time: duration(minutes) }), overdue: false };
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return t('format.justNow');
  return t('format.ago', { time: duration(diff / 60_000) });
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
  const key = `source.${actorType}` as MessageKey;
  const label = t(key);
  // ★ 未知来源时 t 会原样回键名 —— 那时宁可显示原始值
  return label === key ? actorType : label;
}

/**
 * ★ 不再读 contracts 的 STATUS_LABELS —— 那张表现在只服务于后端拼句子。
 *   前端走词条，才能跟着界面语言走。
 *   No longer reads STATUS_LABELS from contracts: that table now only serves
 *   server-side sentence building. The UI follows the selected locale.
 */
export function statusLabel(status: string): string {
  const key = `workItemStatus.${status}` as MessageKey;
  const label = t(key);
  return label === key ? status : label;
}

export function riskLabel(risk: string): string {
  const key = `risk.${risk}` as MessageKey;
  const label = t(key);
  return label === key ? risk : label;
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
/**
 * 领域事件的可读名 / Human-readable domain event names.
 *
 * ★ 事件类型是给系统看的（work_item.status_changed），活动流是给项目负责人
 *   看的。总览页上那条「最近活动」如果直接印事件键，它就从「项目在发生什么」
 *   退化成一段日志 —— 而看日志不是负责人的工作。
 *
 * ★ 兜底不回落到 key，而是按前缀给个粗粒度的说法：将来新增事件类型时，
 *   页面上出现的是「任务变更」而不是一串下划线。
 *
 *   Event types are for the system; the activity feed is for whoever runs the
 *   project. Falling back to the raw key would turn "what is happening" into a
 *   log. Unknown types degrade to a coarse per-prefix label instead.
 */
export function eventLabel(type: string): string {
  const key = `event.${type}` as MessageKey;
  const known = t(key);
  if (known !== key) return known;

  const prefixKey = `eventPrefix.${type.split('.')[0] ?? ''}` as MessageKey;
  const coarse = t(prefixKey);
  return coarse === prefixKey ? type : coarse;
}

