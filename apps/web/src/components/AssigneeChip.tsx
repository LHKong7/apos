import { useT, type MessageKey } from '../lib/i18n';
import clsx from 'clsx';

export type ActorState = 'idle' | 'running' | 'blocked' | 'failed';

interface Props {
  actor: { type: string; id: string; name: string };
  state?: ActorState;
  size?: 'sm' | 'md';
  onClick?: () => void;
}

/**
 * ★ 人机视觉区分的唯一实现（docs/tech/08-frontend-architecture.md §7.1）。
 *
 * 区分靠**形状 + 边框 + 字体**三重，不是只靠颜色 ——
 * 色觉障碍用户看不出蓝色和绿色的差别，但看得出圆形和方形、实线和虚线。
 *
 * 这个组件只能有一处实现。散落各页面自己拼样式，
 * 「人还是 Agent 在做」这条产品最核心的视觉差异就会不一致。
 */
export function AssigneeChip({ actor, state = 'idle', size = 'md', onClick }: Props) {
  const t = useT();
  const isAgent = actor.type === 'agent';
  const text = size === 'sm' ? 'text-[11px]' : 'text-xs';
  const Wrapper = onClick ? 'button' : 'span';

  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={t('chip.agentOrHuman', { kind: isAgent ? 'Agent' : t('chip.human'), name: actor.name })}
      className={clsx(
        'inline-flex max-w-full items-center gap-1 truncate align-middle transition',
        text,
        onClick && 'hover:bg-slate-100',
        isAgent
          ? // Agent：方形 + 虚线边框 + 等宽字体
            'rounded-md border border-dashed border-agent/60 bg-agent/10 px-1.5 py-0.5 font-mono text-agent'
          : // 人类：圆形头像 + 无边框 + 常规字体
            'rounded-full py-0.5 pr-1.5 text-slate-700',
        isAgent && onClick && 'hover:border-agent hover:bg-agent/15',
      )}
    >
      {isAgent ? (
        <span aria-hidden className="shrink-0 text-[10px] leading-none">
          ▪
        </span>
      ) : (
        /* 头像用渐变而不是平灰：一屏几十个人名时，平灰的圆点全都长一样，
           渐变至少让「这是个人」这件事在扫视里立得住 */
        <span
          aria-hidden
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-300 to-slate-400 text-[9px] font-medium text-white"
        >
          {actor.name.slice(0, 1)}
        </span>
      )}
      <span className="truncate">{actor.name}</span>
      {isAgent && <StatusDot state={state} />}
    </Wrapper>
  );
}

const DOT_STYLES: Record<ActorState, string> = {
  idle: 'bg-slate-400',
  running: 'bg-emerald-500 animate-breathe',
  blocked: 'bg-blocked',
  failed: 'bg-overdue',
};

/**
 * 状态 → 词条键 / Actor state → message key.
 *
 * ★★ 存**键**不存译文。模块级常量取不到 hook，`t()` 在这里只会跑一次 ——
 *   切语言时它不重算，圆点的 tooltip 会永远停在启动时那个语言。
 *   翻译发生在渲染处（见 lib/i18n/index.ts 里 useT 的理由）。
 */
const DOT_KEYS: Record<ActorState, MessageKey> = {
  idle: 'chip.idle',
  running: 'chip.running',
  blocked: 'chip.blocked',
  failed: 'chip.failed',
};

export function StatusDot({ state }: { state: ActorState }) {
  const t = useT();
  const label = t(DOT_KEYS[state]);
  return (
    /*
     * ★ 「执行中」额外套一圈向外扩散的涟漪。
     *   静止的绿点和静止的灰点在扫视里是同一个东西 ——
     *   真的在动的那个才读得出「此刻有 Agent 在跑」。
     *   减少动态效果的系统设置会把它停掉（见 index.css）。
     */
    <span
      title={label}
      aria-label={label}
      className="relative flex h-1.5 w-1.5 shrink-0"
    >
      {state === 'running' && (
        <span aria-hidden className="absolute inset-0 rounded-full bg-emerald-500 animate-ping-soft" />
      )}
      <span className={clsx('relative h-1.5 w-1.5 rounded-full', DOT_STYLES[state])} />
    </span>
  );
}

/** 从卡片状态推断 Agent 的呈现状态 */
export function actorStateFrom(status: string, runStatus: string | null): ActorState {
  if (status === 'failed' || runStatus === 'failed') return 'failed';
  if (status === 'blocked') return 'blocked';
  if (status === 'executing' || runStatus === 'running') return 'running';
  return 'idle';
}
