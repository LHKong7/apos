import { useT, type MessageKey } from '../../lib/i18n';
import { joinList, policyEnvLabel, policyOperationLabel, riskName } from '@/lib/format';
import clsx from 'clsx';
import type { OperationOutcome } from '@apos/domain';
import { GatedButton } from '../../components/Gated';
import type { PolicyRow } from '../../lib/api/types';

/**
 * 操作开关矩阵 —— 这一页的第一屏（页面文档 13 §5.1，本轮改为可操作）。
 *
 * ★★ 在此之前这里是一份**只读**的三列清单：「自动执行 / 需人确认 / 视情况」。
 *   它回答了「现在是什么样」，却没回答「怎么改」—— 而改的入口在下面的
 *   规则列表里，形态完全不同：那里是条件、动作、优先级。
 *
 *   于是用户每次都要做一次翻译：把「部署这件事我想让 Agent 自己干」
 *   翻成「一条 operationType == deploy、动作是 allow 的规则」，
 *   保存完再滚回顶部确认自己翻对了。看得见的那一行和改得动的那一行
 *   不是同一行 —— 这个断层是这一页最大的成本。
 *
 *   现在它们是同一行：点哪一行就改哪一行。
 *
 * ★★ 三态里只有两态可点。「视情况」是系统**报告**出来的状态
 *   （比如「在生产环境时需要人确认」），不是一个用户能选的选项 ——
 *   它背后是条件更细的规则，选不出来，只说得出来。做成可点的第三个按钮，
 *   等于让用户选一个系统无法兑现的承诺。
 *
 * The operation switch matrix. This used to be a read-only three-column list:
 * it answered "what is it now" but not "how do I change it", and the place to
 * change it looked nothing like it — conditions, actions, priorities. Every
 * change meant translating "I want Agents to deploy on their own" into a rule
 * and then scrolling back up to check the translation. The row you can see and
 * the row you can change are now the same row.
 *
 * Only two of the three states are clickable: "depends" is a state the system
 * reports, not one a user can pick — offering it as a button would be offering
 * a promise nothing can keep.
 */
export interface OperationRow {
  outcome: OperationOutcome;
  /** 这一行的开关规则（有就说明这一行是被开关设过的），没有则 null */
  switchRule: PolicyRow | null;
}

/**
 * 「什么情况下需要人」的那半句。
 *
 * ★ 三种形态各自一条整句词条，不是在一句话上挖槽。
 *   「在生产环境，或风险等级为高时需要人确认」在英文里是
 *   "Needs a person in Production, or at High risk" —— 连接词的位置不同，
 *   拼不出来。
 */
function useGateText() {
  const t = useT();
  return (outcome: OperationOutcome): string => {
    const gate = outcome.gate;
    if (!gate) return outcome.when ?? '';

    const envs = joinList(gate.environments.map(policyEnvLabel));
    /** ★ 用光秃秃的等级名 —— 下面那两条词条自己带了「风险 / risk」 */
    const risks = joinList(gate.riskLevels.map(riskName));

    if (gate.environments.length > 0 && gate.riskLevels.length > 0) {
      return t('policy.switch.gatedByBoth', { envs, risks });
    }
    if (gate.environments.length > 0) return t('policy.switch.gatedByEnv', { envs });
    if (gate.riskLevels.length > 0) return t('policy.switch.gatedByRisk', { risks });
    return t('policy.switch.gatedByCount', { gated: gate.gatedCount, total: gate.totalCount });
  };
}

export function OperationMatrix({
  rows,
  projectId,
  onSet,
  onClear,
  busyOperation,
}: {
  rows: OperationRow[];
  projectId: string;
  onSet: (operationType: string, verdict: 'auto' | 'human') => void;
  onClear: (operationType: string) => void;
  /** 正在提交的那一行，避免连点 */
  busyOperation: string | null;
}) {
  const t = useT();
  const gateText = useGateText();

  return (
    <div className="mt-2 border-t border-slate-100 pt-2">
      <p className="text-[11px] text-slate-400">{t('policy.switch.hint')}</p>

      <ul className="mt-1 divide-y divide-slate-100">
        {rows.map(({ outcome, switchRule }) => {
          const busy = busyOperation === outcome.operationType;
          return (
            <li
              key={outcome.operationType}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs text-slate-800">
                  {policyOperationLabel(outcome.operationType)}
                </p>
                {/*
                  ★ 「视情况」必须说清楚是什么情况。只写「看情况」的摘要
                    还不如不给 —— 用户仍然得自己去读规则。
                  ★ 按结构拼，不用服务端那句中文：连接词、语序、量词
                    在两种语言里都不同，整句照抄等于把中文抄进英文界面。
                */}
                {outcome.verdict === 'depends' && (
                  <p className="text-[11px] text-slate-400">{gateText(outcome)}</p>
                )}
                {outcome.verdict === 'human' && outcome.byAction && (
                  <p className="text-[11px] text-slate-400">
                    {t(`policy.action.${outcome.byAction}` as MessageKey)}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-1">
                {/*
                  ★ 「视情况」是报告出来的状态，只显示不可点 —— 它背后是条件
                    更细的规则，从这一行选不出来。
                */}
                {outcome.verdict === 'depends' && (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                    {t('policy.dependsOn')}
                  </span>
                )}

                <SwitchButton
                  active={outcome.verdict === 'auto'}
                  busy={busy}
                  permission="policy.loosen"
                  projectId={projectId}
                  activeClass="bg-green-700 text-white"
                  onClick={() => onSet(outcome.operationType, 'auto')}
                >
                  {t('policy.auto')}
                </SwitchButton>

                <SwitchButton
                  active={outcome.verdict === 'human'}
                  busy={busy}
                  permission="policy.tighten"
                  projectId={projectId}
                  activeClass="bg-amber-700 text-white"
                  onClick={() => onSet(outcome.operationType, 'human')}
                >
                  {t('policy.needsHuman')}
                </SwitchButton>

                {/*
                  ★ 只有这一行**是被开关设过的**才给「清除」。
                    否则清除什么都不会发生，而一个点了没反应的按钮
                    比没有按钮更让人怀疑页面坏了。
                */}
                {switchRule ? (
                  <GatedButton
                    permission="policy.loosen"
                    projectId={projectId}
                    disabled={busy}
                    onClick={() => onClear(outcome.operationType)}
                    className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-50"
                  >
                    {t('policy.switch.clear')}
                  </GatedButton>
                ) : (
                  <span className="w-0" />
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SwitchButton({
  children,
  active,
  busy,
  permission,
  projectId,
  activeClass,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  busy: boolean;
  permission: 'policy.loosen' | 'policy.tighten';
  projectId: string;
  activeClass: string;
  onClick: () => void;
}) {
  return (
    <GatedButton
      permission={permission}
      projectId={projectId}
      disabled={busy}
      pressed={active}
      onClick={onClick}
      className={clsx(
        'rounded border px-1.5 py-0.5 text-[11px]',
        active
          ? `border-transparent ${activeClass}`
          : 'border-slate-300 text-slate-600 hover:bg-slate-50',
      )}
    >
      {children}
    </GatedButton>
  );
}
