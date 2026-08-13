import { useT, useSpecText, type MessageKey } from '../../lib/i18n';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import type { IntegrationRow, IntegrationsResponse } from '../../lib/api/types';
import { Button } from '@/components/ui/button';

/**
 * SoT 取值 → 显示。
 * ★ `apos` 是产品名，两种语言写法一样，不进词条表；另外两个走词条。
 *   `apos` is a product name and reads the same in both languages.
 */
const SOT_KEYS: Record<string, MessageKey | null> = {
  apos: null,
  external: 'sot.external',
  merge: 'sot.twoWayMerge',
};

function sotLabel(value: string, tr: (k: MessageKey) => string): string {
  const key = SOT_KEYS[value];
  if (key === undefined) return value;
  return key === null ? 'APOS' : tr(key);
}

/**
 * Source of Truth 配置（页面文档 14 §5.3）。
 *
 * ★ 这是整个集成设置里唯一带「{t('sot.criticalTag')}」角标的一块，因为它决定的是
 *   *以后哪一边的修改会被丢掉*。而它有一个别的配置都没有的特性：
 *   改错之后不会立刻报错，要等到某天有人发现两边数字对不上。
 *   所以这一屏做了三件别处不做的事 ——
 *   每格标出为什么默认是这个、改动先摆出差异再确认、每次修改都写事件。
 *
 * ★ 预设一键铺满，但铺完之后每一格仍然摆在明面上。
 *   只给预设不给字段，用户就不知道自己的修改哪些会被丢；
 *   只给字段不给预设，普通用户根本配不动（§12.1 的取舍就在这里）。
 */
export function SotPanel({
  integration,
  meta,
  canEdit,
}: {
  integration: IntegrationRow;
  meta: IntegrationsResponse;
  canEdit: boolean;
}) {
  const t = useT();
  const sx = useSpecText();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [confirming, setConfirming] = useState(false);

  const current = Object.fromEntries(
    integration.syncMappings.map((m) => [m.field, m.sourceOfTruth]),
  );
  const value = draft ?? current;
  const dirty = integration.syncMappings.filter((m) => value[m.field] !== m.sourceOfTruth);

  const save = useMutation({
    mutationFn: () =>
      api.updateSyncMapping(
        integration.id,
        integration.syncMappings.map((m) => ({
          field: m.field,
          sourceOfTruth: value[m.field] ?? m.sourceOfTruth,
          strategy: m.strategy,
        })),
      ),
    onSuccess: () => {
      setDraft(null);
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ['integrations'] });
    },
  });

  const setField = (field: string, sot: string) => {
    setDraft({ ...value, [field]: sot });
  };

  const applyPreset = (key: string) => {
    // 预设的逐字段取值由后端目录给出，前端不再抄一份
    const preset = PRESET_FIELDS[key];
    if (!preset) return;
    setDraft({ ...value, ...preset });
  };

  return (
    <div className="border-t border-slate-100 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-xs font-medium text-slate-700">{t('sot.title')}</h3>
        <span className="rounded bg-amber-50 px-1 text-[10px] text-amber-800">{t('sot.criticalTag')}</span>
        <span className="text-[11px] text-slate-400">{t('sot.criticalHint')}</span>
        {integration.sotPreset && (
          <span className="ml-auto text-[11px] text-slate-500">
            {t('sot.currentPreset', {
              preset: (() => {
                const hit = meta.presets.find((p) => p.key === integration.sotPreset);
                return hit ? sx(hit.label, hit.labelEn) : t('sot.custom');
              })(),
            })}
          </span>
        )}
      </div>

      {canEdit && (
        <div className="mt-1 flex flex-wrap gap-1">
          {meta.presets.map((p) => (
            <button
              key={p.key}
              type="button"
              title={sx(p.description, p.descriptionEn)}
              onClick={() => applyPreset(p.key)}
              className={clsx(
                'rounded px-1.5 py-0.5 text-[11px]',
                integration.sotPreset === p.key && !draft
                  ? 'bg-slate-900 text-white'
                  : 'border border-slate-300 text-slate-600 hover:bg-slate-50',
              )}
            >
              {sx(p.label, p.labelEn)}
            </button>
          ))}
        </div>
      )}

      <table className="mt-1.5 w-full text-[11px]">
        <tbody>
          {integration.syncMappings.map((m) => {
            const changed = value[m.field] !== m.sourceOfTruth;
            return (
              <tr key={m.field} className="border-b border-slate-50 last:border-0">
                <td className="w-20 py-1 text-slate-700">{sx(m.fieldLabel, m.fieldLabelEn)}</td>
                <td className="w-28 py-1">
                  {canEdit ? (
                    <select
                      value={value[m.field] ?? m.sourceOfTruth}
                      onChange={(e) => setField(m.field, e.target.value)}
                      aria-label={t('sot.fieldAria', { field: sx(m.fieldLabel, m.fieldLabelEn) })}
                      className={clsx(
                        'w-full rounded border px-1 py-0.5 text-[11px]',
                        changed ? 'border-amber-400 bg-amber-50' : 'border-slate-300',
                      )}
                    >
                      {m.options.map((o) => (
                        <option key={o} value={o}>
                          {sotLabel(o, t)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-slate-700">{sotLabel(m.sourceOfTruth, t)}</span>
                  )}
                </td>
                {/* ★ 每格都说明为什么默认是这个。看不懂默认值道理的用户
                    只会照抄或乱改 —— 两种都通向「哪边数据都不敢信」 */}
                <td className="py-1 text-slate-400">{sx(m.why, m.whyEn)}</td>
                <td className="w-24 py-1 text-right text-slate-500" title={t('sot.onNonSotEdit')}>
                  {sx(m.strategyLabel, m.strategyLabelEn)}
                </td>
                {m.customized && (
                  <td className="w-8 py-1 text-right text-[10px] text-amber-700" title={t('sot.deviated')}>
                    改过
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      {integration.autoRules.length > 0 && (
        <p className="mt-1 text-[11px] text-slate-500">
          {t('sot.autoRules', {
            rules: integration.autoRules
              .map((r) =>
                t('sot.autoRule', { field: sx(r.fieldLabel, r.fieldLabelEn), winner: sotLabel(r.winner, t) }),
              )
              .join('; '),
          })}
        </p>
      )}

      {dirty.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Button variant="neutral" size="xs"
            onClick={() => setConfirming(true)}>
            {t('sot.saveCount', { count: dirty.length })}
          </Button>
          <button
            type="button"
            onClick={() => setDraft(null)}
            className="text-[11px] text-slate-500 hover:text-slate-700"
          >
            {t('sot.revert')}
          </button>
        </div>
      )}

      {/**
       * ★ 二次确认摆的是差异本身，不是一句「确定吗」。
       *   「状态：APOS → 外部系统」后面必须跟上这个改动的后果 ——
       *   用户点确定之前，得知道自己刚刚把谁的修改判了死刑。
       */}
      {confirming && (
        <Modal onClose={() => setConfirming(false)} title={t('sot.confirmTitle')}>
          <h2 className="mb-1.5 text-sm font-semibold text-slate-900">{t('sot.confirmTitle')}</h2>
          <p className="text-xs text-slate-600">
            {t('sot.confirmIntro')}
          </p>
          <ul className="mt-1.5 space-y-1">
            {dirty.map((m) => (
              <li key={m.field} className="rounded bg-slate-50 px-2 py-1 text-xs">
                <span className="text-slate-800">{sx(m.fieldLabel, m.fieldLabelEn)}</span>
                <span className="ml-1.5 text-slate-500">
                  {sotLabel(m.sourceOfTruth, t)} → {sotLabel(value[m.field] ?? '', t)}
                </span>
                <span className="mt-0.5 block text-[11px] text-amber-800">
                  {t('sot.effect', {
                    winner: sotLabel(value[m.field] ?? '', t),
                    loser: sotLabel(value[m.field] === 'apos' ? 'external' : 'apos', t),
                    strategy: sx(m.strategyLabel, m.strategyLabelEn),
                  })}
                </span>
              </li>
            ))}
          </ul>

          {save.error && (
            <p className="mt-1.5 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
              {save.error instanceof ApiError ? save.error.message : t('sot.saveFailed')}
            </p>
          )}

          <div className="mt-2 flex gap-1.5">
            <Button variant="neutral" size="sm"
              disabled={save.isPending}
              onClick={() => save.mutate()}>
              {save.isPending ? t('sot.saving') : t('sot.confirm')}
            </Button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="text-xs text-slate-500 hover:text-slate-700"
            >
              取消
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * 预设的逐字段取值。
 *
 * ★ 这里和后端 SOT_PRESETS 是同一份数据的两处表述 —— 本该只有一份。
 *   之所以还留着，是因为预设只影响未保存的草稿，真正落库的是
 *   下面 select 里的逐字段值，服务端会重新校验每一格。
 *   即便这份抄错了，也只会让草稿显示成另一个预设，不会写入非法配置。
 */
const PRESET_FIELDS: Record<string, Record<string, string>> = {
  apos_led: {
    requirement_content: 'apos',
    status: 'apos',
    assignee: 'apos',
    due_date: 'apos',
    comments: 'merge',
    artifact_links: 'apos',
  },
  external_led: {
    requirement_content: 'external',
    status: 'external',
    assignee: 'external',
    due_date: 'external',
    comments: 'merge',
    artifact_links: 'apos',
  },
  split: {
    requirement_content: 'apos',
    status: 'apos',
    assignee: 'external',
    due_date: 'external',
    comments: 'merge',
    artifact_links: 'apos',
  },
};
