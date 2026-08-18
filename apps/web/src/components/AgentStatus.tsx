import clsx from 'clsx';
import { useT, type MessageKey } from '@/lib/i18n';

/**
 * Agent 的两个状态 —— 它们不是一回事 / Two independent agent states.
 *
 * ★★ 「● 正常」此前同时表示 active 和 retired：界面只分了 paused 与
 *   「其余」，于是一个已停用的 Agent 在花名册上是绿的，而看板上说它
 *   「状态为 retired」；鼠标停上去 tooltip 又写着「已停用：<原因>」——
 *   徽标的颜色、文字和它自己的 tooltip 三者互相打架
 *   （问题记录 #10 / #11）。
 *
 * ★★ 生命周期（在岗 / 暂停 / 已停用）与项目成员关系（在这个项目里 /
 *   组织里有但没加进来）是两个正交的问题，混成一列就一定会出现
 *   「花名册说好、看板说不行」这种自相矛盾。所以是两个徽标。
 *
 * Lifecycle and project membership are orthogonal; collapsing them into one
 * column is what made the roster and the board contradict each other.
 */

const LIFECYCLE: Record<string, { labelKey: MessageKey; hintKey: MessageKey; style: string }> = {
  active: {
    labelKey: 'agentState.active',
    hintKey: 'agentState.active.hint',
    style: 'bg-emerald-50 text-emerald-700',
  },
  paused: {
    labelKey: 'agentState.paused',
    hintKey: 'agentState.paused.hint',
    style: 'bg-amber-50 text-amber-800',
  },
  retired: {
    labelKey: 'agentState.retired',
    hintKey: 'agentState.retired.hint',
    /** ★ 灰而不是绿：已停用的东西不该看起来一切正常 */
    style: 'bg-slate-100 text-slate-500 line-through decoration-slate-400',
  },
};

export function AgentLifecycleBadge({
  status,
  reason,
  className,
}: {
  status: string;
  /** 暂停 / 停用的原因。★ 它是**补充**，不能和徽标本体说的话相反 */
  reason?: string | null;
  className?: string;
}) {
  const t = useT();
  const spec = LIFECYCLE[status];

  /** ★ 认不出来的状态原样显示，不装成「正常」—— 静默归一是这类 bug 的源头 */
  if (!spec) {
    return (
      <span className={clsx('rounded px-1.5 py-0.5 text-[11px] bg-slate-100 text-slate-600', className)}>
        {status}
      </span>
    );
  }

  return (
    <span
      className={clsx('rounded px-1.5 py-0.5 text-[11px]', spec.style, className)}
      title={reason ? `${t(spec.hintKey)} — ${reason}` : t(spec.hintKey)}
    >
      {t(spec.labelKey)}
    </span>
  );
}

export function ProjectMembershipBadge({
  inProject,
  className,
}: {
  inProject: boolean | null;
  className?: string;
}) {
  const t = useT();
  /** ★ 组织级视图里没有「本项目」，这一栏就不该出现 —— 空着比猜一个值好 */
  if (inProject === null) return null;

  return (
    <span
      className={clsx(
        'rounded px-1.5 py-0.5 text-[11px]',
        inProject ? 'bg-sky-50 text-sky-700' : 'bg-slate-100 text-slate-500',
        className,
      )}
      title={inProject ? t('agentState.member.hint') : t('agentState.notMember.hint')}
    >
      {inProject ? t('agentState.member') : t('agentState.notMember')}
    </span>
  );
}
