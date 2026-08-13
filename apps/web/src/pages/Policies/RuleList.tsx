import { useT } from '../../lib/i18n';
import clsx from 'clsx';
import { GatedButton } from '../../components/Gated';
import type { Permission, PolicyRow } from '../../lib/api/types';

/**
 * 规则列表（页面文档 13 §5.3）。
 *
 * ★ 每条规则显示的是**人话解释**，不是条件表达式。
 *   真正需要设定 Agent 边界的是项目负责人，不是工程师 ——
 *   `risk == 'low' && cost < 10` 他看不懂，也就不会去管，
 *   最后治理配置就只剩工程师一个人在维护。
 *
 * ★ 命中统计是这一页被低估的部分：命中 0 次说明规则可能写错了，
 *   命中频繁且结果一致说明可以进一步自动化，平均等待长说明它是流程瓶颈。
 */
export function RuleList({
  title,
  hint,
  policies,
  onEdit,
  onToggle,
  onDelete,
  onHistory,
  onViewHits,
  highlightIds,
}: {
  title: string;
  hint: string;
  policies: PolicyRow[];
  onEdit: (p: PolicyRow) => void;
  onToggle: (p: PolicyRow) => void;
  onDelete: (p: PolicyRow) => void;
  onHistory: (p: PolicyRow) => void;
  onViewHits: (p: PolicyRow) => void;
  highlightIds: Set<string>;
}) {
  const t = useT();
  if (policies.length === 0) {
    return (
      <section className="rounded border border-slate-200 bg-white px-3 py-2">
        <h2 className="text-xs font-medium text-slate-700">{title}</h2>
        <p className="mt-2 text-center text-xs text-slate-400">{t('ruleList.empty')}</p>
      </section>
    );
  }

  return (
    <section className="rounded border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-3 py-1.5">
        <h2 className="text-xs font-medium text-slate-700">
          {title}（{policies.length}）
        </h2>
        <p className="text-[11px] text-slate-400">{hint}</p>
      </div>

      <ul>
        {policies.map((p) => (
          <li
            key={p.id}
            className={clsx(
              'border-b border-slate-100 px-3 py-2 last:border-0',
              highlightIds.has(p.id) && 'bg-amber-50',
              !p.enabled && 'opacity-60',
            )}
          >
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-400">{p.projectId === null ? t('ruleList.orgLevel') : t('ruleList.projectLevel')}</span>
              <span className="font-medium text-slate-900">{p.name}</span>
              <span className="text-[11px] text-slate-400">{t('ruleList.priority', { n: p.priority })}</span>
              <span className={clsx('text-[11px]', p.enabled ? 'text-green-700' : 'text-slate-400')}>
                {p.enabled ? t('ruleList.enabled') : t('ruleList.disabled')}
              </span>
            </div>

            {/* ★ 这一行才是给人读的。条件表达式在编辑器里，列表上不出现 */}
            <p className="mt-0.5 text-xs leading-5 text-slate-600">{p.explanation}</p>

            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
              <button
                type="button"
                onClick={() => onViewHits(p)}
                className={clsx(
                  'underline',
                  p.hits30d === 0 ? 'text-slate-400' : 'text-slate-600 hover:text-slate-900',
                )}
              >
                {t('ruleList.hits30d', { count: p.hits30d })}
              </button>

              {p.editable ? (
                <>
                  {/*
                    ★ 编辑按 policy.tighten 判 —— 那是「改规则」的下限。
                      这次改动到底算收紧还是放宽，要把新旧规则各跑一遍场景
                      才知道，前端算不了，也不该算。所以这里只挡掉
                      「连收紧都不够格」的人，真正的方向判定在保存时由服务端做，
                      驳回文案会说清楚是因为放宽。
                  */}
                  <Action permission="policy.tighten" onClick={() => onEdit(p)}>
                    {t('common.edit')}
                  </Action>
                  {/* ★ 停用就是把治理拿掉，与放宽同档 */}
                  <Action
                    permission={p.enabled ? 'policy.loosen' : 'policy.tighten'}
                    onClick={() => onToggle(p)}
                  >
                    {p.enabled ? t('policy.disable') : t('policy.enable')}
                  </Action>
                  <Action permission="policy.loosen" onClick={() => onDelete(p)}>
                    {t('common.delete')}
                  </Action>
                </>
              ) : (
                <span className="text-slate-400">{t('ruleList.orgReadOnly')}</span>
              )}
              {/* 变更历史是只读的 —— 谁都该看得到规则怎么变成今天这样 */}
              <Action permission="policy.view" onClick={() => onHistory(p)}>
                {t('ruleList.changeHistory')}
              </Action>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Action({
  children,
  onClick,
  permission,
}: {
  children: React.ReactNode;
  onClick: () => void;
  permission: Permission;
}) {
  return (
    <GatedButton
      permission={permission}
      onClick={onClick}
      className="rounded border border-slate-300 px-1.5 py-0.5 text-slate-600 hover:bg-slate-50"
    >
      {children}
    </GatedButton>
  );
}
