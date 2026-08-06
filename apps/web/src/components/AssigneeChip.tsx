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
  const isAgent = actor.type === 'agent';
  const text = size === 'sm' ? 'text-[11px]' : 'text-xs';
  const Wrapper = onClick ? 'button' : 'span';

  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={`${isAgent ? 'Agent' : '人类'}：${actor.name}`}
      className={clsx(
        'inline-flex max-w-full items-center gap-1 truncate align-middle',
        text,
        onClick && 'hover:bg-slate-100',
        isAgent
          ? // Agent：方形 + 虚线边框 + 等宽字体
            'rounded border border-dashed border-agent/60 bg-agent/5 px-1.5 py-0.5 font-mono text-agent'
          : // 人类：圆形头像 + 无边框 + 常规字体
            'rounded-full py-0.5 pr-1.5 text-slate-700',
      )}
    >
      {isAgent ? (
        <span aria-hidden className="shrink-0 text-[10px] leading-none">
          ▪
        </span>
      ) : (
        <span
          aria-hidden
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-slate-300 text-[9px] font-medium text-slate-700"
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

const DOT_LABELS: Record<ActorState, string> = {
  idle: '空闲',
  running: '执行中',
  blocked: '阻塞',
  failed: '失败',
};

export function StatusDot({ state }: { state: ActorState }) {
  return (
    <span
      title={DOT_LABELS[state]}
      aria-label={DOT_LABELS[state]}
      className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', DOT_STYLES[state])}
    />
  );
}

/** 从卡片状态推断 Agent 的呈现状态 */
export function actorStateFrom(status: string, runStatus: string | null): ActorState {
  if (status === 'failed' || runStatus === 'failed') return 'failed';
  if (status === 'blocked') return 'blocked';
  if (status === 'executing' || runStatus === 'running') return 'running';
  return 'idle';
}
