import { useT, type MessageKey } from '../../lib/i18n';
import { joinList } from '@/lib/format';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import type {
  IntegrationRow,
  IntegrationsResponse,
  NotificationConfigRow,
} from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const ESCALATE_KEYS: Record<string, MessageKey> = {
  assignee: 'notify.remindOwner',
  project_owner: 'notify.remindLead',
  manager: 'notify.remindManager',
};

/**
 * Notification settings (page doc 14 §5.5 / product doc 11) / 通知配置。
 *
 * ★ Notifications are designed around "something needs your action", not around
 *   shipping a firehose of Agent logs. "Every work item status change" and
 *   "every Agent run" are off by default, and the page states why right there.
 *   That is not conservatism, it is arithmetic: turn everything on by default
 *   and the user mutes the bot within two days, after which they stop receiving
 *   the notifications that genuinely needed action too. What is lost then is not
 *   those two toggles — it is all of them.
 */
export function NotificationPanel({
  integration,
  meta,
  projectId,
  canEdit,
}: {
  integration: IntegrationRow;
  meta: IntegrationsResponse;
  projectId: string;
  canEdit: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const saved = integration.notificationConfig!;
  const [draft, setDraft] = useState<NotificationConfigRow | null>(null);
  const config = draft ?? saved;

  const save = useMutation({
    mutationFn: () => api.updateNotifications(integration.id, config),
    onSuccess: () => {
      setDraft(null);
      void qc.invalidateQueries({ queryKey: qk.integrations(projectId) });
    },
  });

  const toggle = (key: string) => {
    const events = config.events.includes(key)
      ? config.events.filter((e) => e !== key)
      : [...config.events, key];
    setDraft({ ...config, events });
  };

  const dirty = draft !== null;
  const noisyOn = meta.notifyEvents.filter((e) => e.noisy && config.events.includes(e.key));

  return (
    <div className="border-t border-slate-100 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-xs font-medium text-slate-700">{t('notify.whatToSend')}</h3>
        <span className="text-[11px] text-slate-400">{t('notify.actionableOnly')}</span>
      </div>

      <div className="mt-1 grid grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-3">
        {meta.notifyEvents.map((e) => (
          <Label
            key={e.key}
            className={clsx(
              'flex items-center gap-1.5 text-[11px]',
              e.noisy ? 'text-slate-500' : 'text-slate-700',
            )}
          >
            <Checkbox
              disabled={!canEdit}
              checked={config.events.includes(e.key)}
              onCheckedChange={() => toggle(e.key)}
            />
            {e.label}
            {e.noisy && <span className="text-slate-400">{t('notify.offByDefault')}</span>}
          </Label>
        ))}
      </div>

      {/**
       * ★ State the cost at the moment a high-volume notification is switched
       *   on, rather than leaving the user to work it out after being flooded.
       *   The point of this hint is not to stop them; it is to let them see
       *   what they are trading away.
       */}
      {noisyOn.length > 0 && (
        <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          {t('notify.noisyWarning', { events: joinList(noisyOn.map((e) => e.label)) })}
        </p>
      )}

      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600">
        <Label className="flex items-center gap-1">
          {t('notify.dailyDigest')}
          <Input
            type="time"
            disabled={!canEdit}
            value={config.dailyDigestAt ?? ''}
            onChange={(e) => setDraft({ ...config, dailyDigestAt: e.target.value || null })} />
        </Label>
        <Label className="flex items-center gap-1">
          {t('notify.quietHours')}
          <Input
            type="time"
            disabled={!canEdit}
            value={config.quietHours?.from ?? ''}
            onChange={(e) =>
              setDraft({
                ...config,
                quietHours: { from: e.target.value, to: config.quietHours?.to ?? '08:00' },
              })
            } />
          –
          <Input
            type="time"
            disabled={!canEdit}
            value={config.quietHours?.to ?? ''}
            onChange={(e) =>
              setDraft({
                ...config,
                quietHours: { from: config.quietHours?.from ?? '22:00', to: e.target.value },
              })
            } />
        </Label>
        {/* ★ Quiet hours protect attention, not accountability — a high-risk decision must still get through */}
        <Label className="flex items-center gap-1">
          <Checkbox
            disabled={!canEdit}
            checked={config.quietHoursExceptHighRisk}
            onCheckedChange={(v) => setDraft({ ...config, quietHoursExceptHighRisk: v })}
          />
          {t('notify.highRiskExempt')}
        </Label>
      </div>

      {/* Escalation rules (product doc 11) */}
      <div className="mt-1.5">
        <p className="text-[11px] text-slate-500">{t('notify.escalate')}</p>
        <ul className="mt-0.5 space-y-0.5">
          {config.escalation.map((e, i) => (
            <li key={i} className="text-[11px] text-slate-600">
              ·{' '}
              {t('notify.escalateRule', {
                hours: e.afterHours,
                target: ESCALATE_KEYS[e.notify] ? t(ESCALATE_KEYS[e.notify]!) : e.notify,
              })}
              {e.pauseCriticalPath && (
                <span className="ml-1 text-amber-700">{t('notify.pauseCriticalPath')}</span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/**
       * ★ There is deliberately no "approve right here" button inside a
       *   notification (§12.3 leans toward deep links only for the MVP).
       *   Approving from inside a third-party platform requires proving on that
       *   side that whoever pressed the button really is the person accountable
       *   for the decision, and every platform does that differently. An
       *   "approve" that cannot prove it turns a non-delegable decision into
       *   whoever-clicks-first, which is worse than not shipping it.
       */}
      <p className="mt-1.5 text-[11px] text-slate-400">
        {t('notify.linkOnlyNote')}
      </p>

      {canEdit ? (
        dirty && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Button variant="neutral" size="xs"
              disabled={save.isPending}
              onClick={() => save.mutate()}>
              {save.isPending ? t('common.saving') : t('notify.save')}
            </Button>
            <Button variant="ghost"
              onClick={() => setDraft(null)}
              className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-[11px] text-slate-500 hover:text-slate-700"
            >
              {t('notify.revert')}
            </Button>
          </div>
        )
      ) : (
        <p className="mt-1.5 text-[11px] text-slate-400">
          {t('notify.needPm')}
        </p>
      )}

      {save.error && (
        <p className="mt-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {save.error instanceof ApiError ? save.error.message : t('notify.saveFailed')}
        </p>
      )}
    </div>
  );
}
