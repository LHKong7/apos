import { currentLocale, t, type MessageKey } from '../i18n';

/**
 * token 用量。
 *
 * ★ 缩写而不是印全数：看板卡片、Agent 列表这些地方要能**一眼横向比较**，
 *   而 1,203,884 和 984,120 放在一起，先看到的是长度不是大小。
 *   1.2M 和 984k 才是能扫一眼就排出序的写法。
 *
 * ★ 不带千分位本地化：数字缩写在中英文里读法一致（1.2M），
 *   而 `toLocaleString` 会按 locale 换分隔符，让同一份界面在两种语言下
 *   宽度不同 —— 卡片布局会跟着抖。
 *
 * Token usage, abbreviated. Cards and tables need to be scannable: two full
 * counts side by side read as lengths before they read as magnitudes.
 */
/**
 * ★★ 「不知道」和「零」必须分开显示。
 *
 *   这里以前是 `Number(value ?? 0)` —— null 被折叠成 0，界面上出现一个
 *   干净的「0」。而 null 的真实含义是**该运行时不上报用量**
 *   （opencode / pi / aider 的能力清单里 `tokenReporting: false`），
 *   于是用户读到的是「这次没花 token」——一个我们并不知道的事实。
 *
 *   能力清单那套设计的全部要点就是「不静默降级」：缺什么能力要让人看见。
 *   把 unknown 折叠成 0 正是它要禁止的事。
 *
 *   Unknown must not render as zero: a null token count means the runtime
 *   does not report usage, and "0" states something we do not know.
 */
export const UNKNOWN = '—';

export function tokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return UNKNOWN;
  const n = Number(value);
  if (!Number.isFinite(n)) return UNKNOWN;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trimUnit(n / 1e9)}B`;
  if (abs >= 1e6) return `${trimUnit(n / 1e6)}M`;
  if (abs >= 1e3) return `${trimUnit(n / 1e3)}k`;
  return String(Math.round(n));
}

function trimUnit(v: number): string {
  return v.toFixed(Math.abs(v) < 10 ? 1 : 0).replace(/\.0$/, '');
}

/**
 * 美元金额。
 *
 * ★ 记账单位已经是 token，这个函数只剩两处用途：ROI（要和人力成本相减，
 *   见 domain/analytics/benefit.ts）和 Run 详情里那个标着「参考」的结算值。
 *   任何新的成本展示都该用 `tokens()` —— 用了这个就意味着那个数会随
 *   官方调价漂移。
 *
 * Only ROI (which must share a unit with labour cost) and the run detail's
 * reference figure still use this. Anything new should use `tokens()`.
 */
export function money(value: string | number | null | undefined): string {
  /**
   * ★★ null / 认不出的值 = **没有上报**，不是 0。
   *
   *   此前这里是 `Number(value ?? 0)` 外加「不是有限数就返回 $0.00」，
   *   于是不上报成本的运行时（opencode 就是一个）跑完一次真实规划后，
   *   计划页上写着 $0.00 —— 与「这次确实免费」完全无法区分，
   *   读者得到的结论是「规划不花钱」。
   *   tokens() 那边早有这个约定，成本这条一直漏着。
   *
   * A missing figure is not a zero one: render it as unknown.
   */
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
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

/**
 * 相对时间。
 *
 * ★★ 一分钟以内也要给出秒级刻度，而不是一律「刚刚」。
 *
 *   总览页那条「最近活动」上曾经十二条全是「刚刚」—— 十二条事件显然不在
 *   同一秒发生，但界面上分不出先后，也看不出频次。而这一列的用途恰恰是
 *   「刚才发生了什么、按什么顺序」：分辨率一丢，它就只剩「有事发生过」
 *   这一点信息（问题记录 #1）。
 *
 *   门槛设在 5 秒：更细的刻度会让同一批事件在两次渲染之间跳动
 *   （「3 秒前」→「7 秒前」），而那种抖动本身就是噪声。
 *
 * ★ 未来时间给「即将」而不是负数。时钟偏移下服务端时间比浏览器快几秒是常态，
 *   而「-3 秒前」看起来像 bug。
 *
 * Sub-minute events need second-level granularity: a column of twelve
 * "just now" rows carries no ordering and no frequency, which is precisely
 * what a recent-activity list is for.
 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  const diff = Date.now() - ms;

  if (diff < 0) return t('format.justNow');
  if (diff < 5_000) return t('format.justNow');
  if (diff < 60_000) return t('format.ago', { time: t('format.seconds', { n: Math.floor(diff / 1000) }) });
  return t('format.ago', { time: duration(diff / 60_000) });
}

/**
 * 绝对时间，给 `title` 用。
 *
 * ★ 相对时间回答「多久以前」，绝对时间回答「几点」—— 排查问题时要的是后者，
 *   而且要能和别人的日志对上。两者不是二选一：相对的在正文里，
 *   绝对的挂在 hover 上（问题记录 #1）。
 */
export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  /**
   * ★ 跟着界面语言走，不跟着浏览器走：整页已经是用户选定的那种语言，
   *   时间戳突然换一种格式会让人以为它来自别处。
   */
  return d.toLocaleString(currentLocale() === 'zh' ? 'zh-CN' : 'en-GB');
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

/**
 * 任务类型的可读名。
 *
 * ★★ 每一处 `typeIcon()` 旁边都该有它。
 *
 *   emoji 在屏幕阅读器里被读成 Unicode 的官方名字 ——「🔍」是
 *   "magnifying glass tilted left"，而它在这里表示的是「调研任务」。
 *   两者毫无关系。图标同时也在小屏、灰度打印和高对比模式下失效
 *   （问题记录 #19）。
 *
 *   做法一律是：emoji 加 `aria-hidden`，紧跟一段 `sr-only` 的这个名字。
 *   看得见的人靠图标扫视，其余人拿到的是一个词。
 *
 * Emoji are announced by their Unicode names, which have nothing to do with
 * what they mean here. Pair every icon with this, aria-hidden on the glyph.
 */
export function typeLabel(type: string): string {
  const key = `workItemType.${type}` as MessageKey;
  const label = t(key);
  return label === key ? type : label;
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

/**
 * 列表连接符 / Joining a list of items.
 *
 * ★★ 中文用顿号「、」，英文用逗号加空格。这件事此前是各处 `join('、')`
 *   硬编码的，于是英文界面上出现 `Requirement、Research`、
 *   `Read、Edit、Bash` —— 一个只在中文里存在的标点，夹在英文词之间。
 *
 * ★ 调用它的组件都用了 useT()（订阅了 locale），所以这里读当前语言
 *   不会漏掉切换时的重渲染。
 */
export function joinList(items: readonly string[]): string {
  return items.join(currentLocale() === 'zh' ? '、' : ', ');
}

/**
 * 标签与值之间的冒号 / The colon between a label and its value.
 *
 * ★ 中文用全角「：」，英文用半角冒号加空格。同上，此前是硬编码的全角冒号，
 *   英文界面上长成 `Can do：Read workspace files`。
 */
export function colon(): string {
  return currentLocale() === 'zh' ? '：' : ': ';
}
