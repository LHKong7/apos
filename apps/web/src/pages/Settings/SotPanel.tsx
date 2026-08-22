import { useT, useSpecText, type MessageKey } from '../../lib/i18n';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import type { IntegrationRow, IntegrationsResponse } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from '@/components/ui/table';

/**
 * SoT value → label / SoT 取值 → 显示。
 * ★ `apos` is a product name and reads the same in both languages, so it stays
 *   out of the message catalog; the other two go through it.
 *   `apos` 是产品名，两种语言写法一样，不进词条表；另外两个走词条。
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
 * Source of Truth configuration (page doc 14 §5.3) / Source of Truth 配置。
 *
 * ★ This is the only block in the integration settings that carries the
 *   "⚠ critical configuration" badge, because what it decides is *whose edits
 *   get thrown away from now on*. It also has a property no other setting has:
 *   getting it wrong raises no error at the time — it surfaces the day someone
 *   notices the two systems disagree. So this screen does three things nothing
 *   else does: it states per row why the default is what it is, it shows the
 *   diff before confirming a change, and it writes an event on every change.
 *
 *   这是唯一带「⚠ 关键配置」角标的一块 —— 它决定以后哪一边的修改会被丢掉，
 *   而改错了不会立刻报错，要等到某天有人发现两边数字对不上。
 *
 * ★ A preset fills every row in one click, yet each row stays visible
 *   afterward. Presets alone and the user cannot tell which of their edits will
 *   be discarded; per-field controls alone and an ordinary user cannot
 *   configure it at all (that is the trade-off in §12.1).
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
    // The per-field values of a preset come from the backend catalog; no second copy here
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
            <Button variant="ghost"
              key={p.key}
              title={sx(p.description, p.descriptionEn)}
              onClick={() => applyPreset(p.key)}
              className={clsx('h-auto p-0 font-normal whitespace-normal hover:bg-transparent', 
                'rounded px-1.5 py-0.5 text-[11px]',
                integration.sotPreset === p.key && !draft
                  ? 'bg-slate-900 text-white'
                  : 'border border-slate-300 text-slate-600 hover:bg-slate-50',
              )}
            >
              {sx(p.label, p.labelEn)}
            </Button>
          ))}
        </div>
      )}

      <Table className="mt-1.5 w-full text-[11px]">
        <TableBody>
          {integration.syncMappings.map((m) => {
            const changed = value[m.field] !== m.sourceOfTruth;
            return (
              <TableRow key={m.field} className="border-b border-slate-50 last:border-0">
                <TableCell className="w-20 py-1 text-slate-700">{sx(m.fieldLabel, m.fieldLabelEn)}</TableCell>
                <TableCell className="w-28 py-1">
                  {canEdit ? (
                    <Select
                      value={value[m.field] ?? m.sourceOfTruth}
                      onValueChange={(v) => setField(m.field, v)}
                    >
                      <SelectTrigger
                        aria-label={t('sot.fieldAria', { field: sx(m.fieldLabel, m.fieldLabelEn) })}
                        className={clsx(
                          'h-auto w-full px-1 py-0.5 text-[11px]',
                          changed ? 'border-amber-400 bg-amber-50' : 'border-slate-300',
                        )}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {m.options.map((o) => (
                          <SelectItem key={o} value={o}>
                            {sotLabel(o, t)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-slate-700">{sotLabel(m.sourceOfTruth, t)}</span>
                  )}
                </TableCell>
                {/* ★ Every row explains why its default is what it is. A user who
                    cannot see the reasoning either copies it blindly or changes it at
                    random — both roads end at "neither side's data can be trusted" */}
                <TableCell className="py-1 text-slate-400">{sx(m.why, m.whyEn)}</TableCell>
                <TableCell className="w-24 py-1 text-right text-slate-500" title={t('sot.onNonSotEdit')}>
                  {sx(m.strategyLabel, m.strategyLabelEn)}
                </TableCell>
                {m.customized && (
                  <TableCell className="w-8 py-1 text-right text-[10px] text-amber-700" title={t('sot.deviated')}>
                    {t('sot.customized')}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

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
          <Button variant="ghost"
            onClick={() => setDraft(null)}
            className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-[11px] text-slate-500 hover:text-slate-700"
          >
            {t('sot.revert')}
          </Button>
        </div>
      )}

      {/**
       * ★ The confirmation shows the diff itself, not a bare "are you sure?".
       *   "Status: APOS → external system" has to be followed by what that
       *   change means — before clicking confirm, the user needs to know whose
       *   edits they just sentenced to be discarded.
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
            <Button variant="ghost"
              onClick={() => setConfirming(false)}
              className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-xs text-slate-500 hover:text-slate-700"
            >
              {t('common.cancel')}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * The per-field values behind each preset / 预设的逐字段取值。
 *
 * ★ This table and the backend's SOT_PRESETS are two statements of the same
 *   data — there should only be one. It survives because a preset only touches
 *   the unsaved draft: what actually reaches the database is the per-field
 *   value in each select below, and the server revalidates every one of them.
 *   Even if this copy were wrong, the worst it does is render the draft as a
 *   different preset; it cannot write an invalid configuration.
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
