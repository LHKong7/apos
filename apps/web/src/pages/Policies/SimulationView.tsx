import { useT } from '../../lib/i18n';
import { joinList, policyFactLabel } from '@/lib/format';
import type { SimulationResponse } from '../../lib/api/types';

/**
 * 模拟结果（§5.7）。
 *
 * ★ 「其中 N 次人类当时是驳回的」比任何说明都更能帮用户发现规则漏洞。
 *   所以这块的排版把不一致案例放在最显眼的位置，
 *   而不是先报一串「会自动处理 47 次」的好消息。
 */
export function SimulationView({ result }: { result: SimulationResponse }) {
  const t = useT();
  const CONFIDENCE = { high: 'rule.sampleAmple', medium: 'rule.sampleFair', low: 'rule.sampleThin' } as const;

  return (
    <div className="mt-1.5 space-y-1.5 text-xs">
      <p className="text-slate-600">
        {t('rule.simulationSummary', {
          total: result.totalSamples,
          handled: result.wouldAutoHandle,
        })}
        <span className="ml-1 text-[11px] text-slate-400">（{CONFIDENCE[result.confidence]}）</span>
      </p>

      {result.mismatches.length > 0 ? (
        <div className="rounded bg-amber-50 px-2 py-1.5">
          <p className="font-medium text-amber-900">
            {t('rule.mismatchWarning', { count: result.mismatches.length })}
          </p>
          <ul className="mt-1 space-y-0.5">
            {result.mismatches.slice(0, 5).map((m) => (
              <li key={m.eventId} className="text-[11px] text-amber-900">
                · {m.occurredAt.slice(0, 10)} {m.workItemTitle}
                {m.humanNote && <span className="text-amber-700">（{m.humanNote}）</span>}
              </li>
            ))}
          </ul>
          {result.suggestions.length > 0 && (
            <p className="mt-1 text-[11px] text-amber-900">
              {t('rule.suggestExclusion')}
              {joinList(
                result.suggestions.map(
                  (s) =>
                    `${policyFactLabel(s.addCondition.fact)} ≠ ${String(s.addCondition.value)}`,
                ),
              )}
              <span className="ml-1 text-amber-700">
                {t('rule.suggestionBasis', {
                  count: result.suggestions[0]!.wouldEliminate,
                })}
              </span>
            </p>
          )}
        </div>
      ) : (
        <p className="rounded bg-green-50 px-2 py-1 text-[11px] text-green-900">
          {t('rule.noMismatches')}
        </p>
      )}

      {/* ★ 局限必须说出来。模拟基于历史事件回放，上下文缺失时会有偏差 */}
      {result.caveats.length > 0 && (
        <ul className="space-y-0.5">
          {result.caveats.map((c) => (
            <li key={c} className="text-[11px] text-slate-400">
              · {c}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

