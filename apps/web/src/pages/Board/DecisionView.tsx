import { useT } from '../../lib/i18n';
import { useMemo } from 'react';
import clsx from 'clsx';
import { AssigneeChip } from '../../components/AssigneeChip';
import { HumanGateBadge, RiskBadge } from '../../components/badges';
import { EmptyState } from '../../components/states';
import { typeIcon } from '../../lib/format';
import type { BoardColumn } from '../../lib/api/types';
import type { CardActions } from '../../features/work-item/BoardCard';
import { Button } from '@/components/ui/button';

/**
 * Human Decision View（页面文档 05 §5.7）。
 *
 * 只看等着人拍板的卡片，按时限升序 —— 最紧急的在最上面。
 * 这是「忙碌用户 2 分钟巡检」的主入口：不需要理解看板全局，
 * 从上往下处理即可。
 */
export function DecisionView({
  columns,
  actions,
}: {
  columns: BoardColumn[];
  actions: CardActions;
}) {
  const t = useT();
  const rows = useMemo(() => {
    const cards = columns.flatMap((c) => c.items).filter((c) => c.humanGate && c.humanGateRef);
    return cards.sort((a, b) => {
      // 无时限的排最后：没截止时间的不该压过快超时的
      const av = a.decisionDueInMinutes ?? Number.POSITIVE_INFINITY;
      const bv = b.decisionDueInMinutes ?? Number.POSITIVE_INFINITY;
      return av - bv;
    });
  }, [columns]);

  if (rows.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon="✅"
          message={t('decisionView.empty')}
          hint={t('decisionView.emptyHint')}
          action={{ label: t('decisionView.backToKanban'), onClick: () => history.back() }}
        />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
      {rows.map((card) => {
        const overdue = card.decisionDueInMinutes !== null && card.decisionDueInMinutes < 0;
        return (
          <article
            key={card.id}
            className={clsx(
              'flex items-center gap-3 rounded-lg border bg-white px-3 py-2',
              overdue ? 'border-overdue/40' : 'border-slate-200',
            )}
          >
            <span aria-hidden>{typeIcon(card.type)}</span>
            <div className="min-w-0 flex-1">
              <Button variant="ghost"
                onClick={() => actions.onOpen(card)}
                className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent justify-start block truncate text-left text-sm font-medium text-slate-900 hover:underline"
              >
                {card.title}
              </Button>
              <div className="mt-0.5 flex flex-wrap items-center gap-2">
                <HumanGateBadge
                  gate={card.humanGate!}
                  dueInMinutes={card.decisionDueInMinutes}
                />
                <RiskBadge risk={card.riskLevel} />
                {card.owner && (
                  <AssigneeChip actor={{ type: 'human', ...card.owner }} size="sm" />
                )}
              </div>
            </div>
            <Button variant="gate" size="sm"
              onClick={() => actions.onHandleGate(card)}
              className="shrink-0 hover:brightness-95">
              {t('card.handle')}
            </Button>
          </article>
        );
      })}
    </div>
  );
}
