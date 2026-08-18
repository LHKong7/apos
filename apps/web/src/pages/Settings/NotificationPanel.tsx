import { useT, type MessageKey } from '../../lib/i18n';
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
 * 通知配置（页面文档 14 §5.5 / 产品文档十一）。
 *
 * ★ 通知围绕「需要行动」设计，而不是发送大量 Agent 日志。
 *   「每个任务状态变化」「每次 Agent 执行」默认关闭，而且界面上
 *   直接把原因写出来 —— 这不是保守，是算过代价的：默认全开的话，
 *   用户会在两天内屏蔽这个机器人，之后连真正需要行动的通知也收不到。
 *   那时候损失的不是这两项，是全部。
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
       * ★ 打开高频通知时当场说清代价，而不是等用户被刷屏之后自己想明白。
       *   这条提示的目的不是阻止他，是让他知道自己在换什么。
       */}
      {noisyOn.length > 0 && (
        <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          {t('notify.noisyWarning', { events: noisyOn.map((e) => e.label).join('、') })}
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
        {/* ★ 免打扰保护的是注意力，不是责任 —— 高风险决策必须能穿透 */}
        <Label className="flex items-center gap-1">
          <Checkbox
            disabled={!canEdit}
            checked={config.quietHoursExceptHighRisk}
            onCheckedChange={(v) => setDraft({ ...config, quietHoursExceptHighRisk: v })}
          />
          {t('notify.highRiskExempt')}
        </Label>
      </div>

      {/* 升级规则（产品文档十一）*/}
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
       * ★ 通知里的「直接批准」按钮没有做（§12.3 倾向 MVP 只做深链）。
       *   在第三方平台内直接执行批准，需要在那一侧确认「点按钮的人
       *   真的是决策责任人」，各平台机制都不一样 ——
       *   做不到这一点的「直接批准」，等于把不可代行的决策
       *   变成谁点谁算，那比不做更糟。
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
