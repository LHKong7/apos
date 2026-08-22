import { useState } from 'react';
import { joinList, colon } from '@/lib/format';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { useSpecText, useT, type MessageKey } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { CardSkeleton, ErrorState } from '@/components/states';
import { ResourceScopeEditor, type ScopeRow } from '@/components/ResourceScopeEditor';
import { Labeled, Notice } from './primitives';
import type { AgentAccessBody, AgentAccessPreview, AgentAccessView } from '@/lib/api/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * The effective permissions of one Agent inside one project / 项目里某个 Agent
 * 的生效权限。
 *
 * ★★ This panel deliberately shows **no runtime tool names**.
 *
 *   `Read` / `Edit` / `Bash(npm test:*)` is a runtime's vocabulary, and the
 *   runtime is a property of the Agent, not a choice the user came here to
 *   make. Configuring tool names here would cost three things: the user has to
 *   learn some CLI first; switching runtimes means configuring it all over
 *   again; and worst of all, the single word `repo:write` used to mean "edit
 *   files in an isolated workspace", "push to the remote", and "merge to main"
 *   at once — three operations whose risk differs by two orders of magnitude,
 *   rendered identically on the authorization screen.
 *
 *   What is shown instead are **capabilities** (the set the server already
 *   evaluated and translated into plain language), each with one sentence
 *   saying what that capability actually lets the Agent do.
 *
 * ★ Every value comes from that one server-side evaluation; the frontend never
 *   recomputes. Recomputing would be a second copy of the evaluator, and the
 *   two copies disagreeing shows up as "the screen says it can push a branch,
 *   but dispatching it fails".
 *
 *   这一页刻意不显示运行时工具名，显示的是服务端算好并翻译成人话的能力。
 *   数值全部来自服务端那一次求值，前端不自己算 —— 抄第二份求值器，分歧会
 *   表现成「界面说它能推分支，实际派下去推不了」。
 */

const RISK_LABEL: Record<string, MessageKey> = {
  low: 'access.risk.low',
  medium: 'access.risk.medium',
  high: 'access.risk.high',
  critical: 'access.risk.critical',
};

const RISK_STYLE: Record<string, string> = {
  low: 'bg-slate-100 text-slate-600',
  medium: 'bg-sky-50 text-sky-700',
  high: 'bg-amber-50 text-amber-800',
  critical: 'bg-rose-50 text-rose-700',
};

export function AgentAccessPanel({
  projectId,
  agentId,
}: {
  projectId: string;
  agentId: string;
}) {
  const t = useT();
  const sx = useSpecText();
  const [editing, setEditing] = useState(false);

  const q = useQuery({
    queryKey: qk.agentAccess(projectId, agentId),
    queryFn: () => api.agentAccess(projectId, agentId),
  });

  if (q.isLoading) return <CardSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data!;

  const profile = data.profiles.find((p) => p.key === data.profileKey);

  return (
    <div className="rounded border border-slate-200 bg-white px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-800">{data.agentName}</span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
          {profile ? sx(profile.name, profile.nameEn) : data.profileKey}
        </span>
        <Button
          variant="outline"
          size="xs"
          onClick={() => setEditing((v) => !v)}
          className="ml-auto"
        >
          {editing ? t('common.cancel') : t('access.change')}
        </Button>
      </div>

      {/*
        ★ "Never configured" has to be stated, not rendered as a configuration
          that looks like the user's own. If the two look alike on screen, the
          user cannot tell whether these permissions are theirs or the
          platform's default.
      */}
      {data.usingDefault && (
        <p className="mt-1 text-[11px] text-slate-500">{t('access.usingDefault')}</p>
      )}

      {/*
        ★★ A newer profile version is only **announced**, never applied
          automatically. Auto-upgrading would mean "the platform edits one
          profile and every Agent widens with it" — the textbook way permission
          creep happens.
      */}
      {data.profileOutdated && <Notice tone="warning">{t('access.outdated')}</Notice>}

      <dl className="mt-2 space-y-1 text-[11px]">
        <div className="flex flex-wrap items-baseline gap-1">
          <dt className="text-slate-500">{t('access.capabilities')}{colon()}</dt>
          <dd className="flex flex-wrap gap-1">
            {data.explained.length === 0 ? (
              <span className="text-slate-400">{t('access.none')}</span>
            ) : (
              data.explained.map((c) => (
                <span
                  key={c.capability}
                  className={clsx('rounded px-1.5 py-0.5', RISK_STYLE[c.risk])}
                  title={`${t(RISK_LABEL[c.risk] ?? 'access.risk.low')}`}
                >
                  {sx(c.label, c.labelEn)}
                </span>
              ))
            )}
          </dd>
        </div>

        <div className="flex flex-wrap items-baseline gap-1">
          <dt className="text-slate-500">{t('access.resources')}{colon()}</dt>
          <dd className="text-slate-700">
            {data.resourceScopes.length === 0
              ? t('access.none')
              : joinList(
                  data.resourceScopes.map(
                    (s) => `${s.ref}（${t(`scopes.access.${s.access}` as MessageKey)}）`,
                  ),
                )}
          </dd>
        </div>
      </dl>

      {/*
        ★★ Restrictions the runtime cannot actually enforce must be shown. On
          this screen such a capability looks exactly like any other, yet on
          this runtime it does not take effect — stay silent and the user
          believes they have constrained something they have not.
      */}
      {data.warnings.length > 0 && (
        <Notice tone="warning">
          {t('access.degraded')}
          <ul className="mt-1 list-disc pl-4">
            {data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}

      {editing && (
        <AccessForm
          projectId={projectId}
          agentId={agentId}
          current={data}
          onDone={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function AccessForm({
  projectId,
  agentId,
  current,
  onDone,
}: {
  projectId: string;
  agentId: string;
  current: AgentAccessView;
  onDone: () => void;
}) {
  const t = useT();
  const sx = useSpecText();
  const qc = useQueryClient();

  const [profileKey, setProfileKey] = useState(current.profileKey);
  const [scopes, setScopes] = useState<ScopeRow[]>(
    current.resourceScopes
      /**
       * ★ The rows the platform supplies by default never enter the form. They
       *   are not the user's configuration — include them and the first save
       *   freezes a default into an explicit setting, which is not the same
       *   thing: an explicit scope stops tracking the project when its
       *   registered repositories change.
       */
      .filter((s) => s.origin !== 'project_default')
      .map((s) => ({ kind: s.kind, ref: s.ref, access: s.access })),
  );
  const [reason, setReason] = useState('');

  const body = (): AgentAccessBody => ({
    profileKey,
    resourceScopes: scopes.filter((s) => s.ref.trim().length > 0),
    reason: reason.trim() || null,
  });

  /**
   * ★★ Before saving, ask the server what would happen — through the **same
   *   evaluator the save path uses**. The frontend could diff two profiles'
   *   capability lists on its own, but that is a second implementation, and it
   *   would disagree with the server precisely on the complex inputs that most
   *   need a preview: a narrowed ceiling, an unsupported runtime, a resource
   *   scope being widened.
   */
  const preview = useQuery<AgentAccessPreview>({
    queryKey: [
      ...qk.agentAccess(projectId, agentId),
      'preview',
      profileKey,
      JSON.stringify(scopes),
    ],
    queryFn: () => api.previewAgentAccess(projectId, agentId, body()),
  });

  const save = useMutation({
    mutationFn: () => api.setAgentAccess(projectId, agentId, body()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.agentAccess(projectId, agentId) });
      onDone();
    },
  });

  const impact = preview.data;
  const needsReason = impact?.requiresReason === true && reason.trim().length === 0;

  return (
    <div className="mt-2 space-y-2 border-t border-slate-200 pt-2">
      <Labeled label={t('access.profile')}>
        <Select value={profileKey} onValueChange={setProfileKey}>
          {/*
            ★ The trigger carries its own aria-label. Labeled **wraps** instead
              of using htmlFor, and implicit association only holds for native
              form controls — Radix's trigger is a button with
              `role="combobox"`, so wrapping it in a <label> still leaves a
              screen reader announcing nothing but "button". The Selects in
              ResourceScopeEditor have been written this way all along.
          */}
          <SelectTrigger aria-label={t('access.profile')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {current.profiles.map((p) => (
              <SelectItem key={p.key} value={p.key}>
                {sx(p.name, p.nameEn)}
              </SelectItem>
            ))}
            {/*
              ★ A migrated grant (legacy_import) is not a built-in profile, so
                it has no option of its own. Keep the current value as one, or
                merely opening the form silently swaps it for a different
                profile.
            */}
            {/* ★ `profileKey &&` as in Members: an empty string makes Radix throw, not drop an item */}
            {profileKey && !current.profiles.some((p) => p.key === profileKey) && (
              <SelectItem value={profileKey}>{profileKey}</SelectItem>
            )}
          </SelectContent>
        </Select>
      </Labeled>
      <p className="text-[11px] text-slate-500">
        {(() => {
          /**
           * ★ The server returns the profile description in both languages
           *   (description / descriptionEn); this spot used to render only the
           *   Chinese one, so the English UI showed a full Chinese paragraph.
           *   That was not a missing translation — it was throwing away English
           *   text that had already shipped.
           */
          const p = current.profiles.find((x) => x.key === profileKey);
          return p ? sx(p.description, p.descriptionEn) : null;
        })()}
      </p>

      <Labeled label={t('access.resources')}>
        <ResourceScopeEditor value={scopes} onChange={setScopes} projectId={projectId} />
      </Labeled>

      {impact && <ImpactSummary impact={impact} />}

      {/*
        ★ The reason box appears only when loosening. Demanding a reason for
          tightening too would make tightening as much work as loosening — and
          tightening is exactly the action we want to stay effortless.
      */}
      {impact?.requiresReason && (
        <Labeled label={t('access.reason')} help={t('access.reasonHelp')}>
          <Textarea
            value={reason}
            aria-label={t('access.reason')}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
          />
        </Labeled>
      )}

      {save.error instanceof ApiError && (
        <p className="text-[11px] text-rose-600">{save.error.message}</p>
      )}

      <div className="flex gap-2">
        <Button
          variant="neutral"
          size="sm"
          disabled={save.isPending || needsReason || preview.isLoading}
          onClick={() => save.mutate()}
        >
          {save.isPending ? t('access.saving') : t('common.save')}
        </Button>
        <Button variant="outline" size="sm" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
      {needsReason && <p className="text-[11px] text-amber-700">{t('access.reasonMissing')}</p>}
    </div>
  );
}

/**
 * The impact summary shown before saving / 保存前的影响摘要。
 *
 * ★★ It states the **consequence**, not the config diff. "Adds
 *   repository.push" means nothing to the user; "it will be able to push
 *   branches to the remote repository" does. The `consequence` sentence in the
 *   capability catalog exists for exactly this spot.
 */
function ImpactSummary({ impact }: { impact: AgentAccessPreview }) {
  const t = useT();

  const headline =
    impact.direction === 'loosen'
      ? t('access.preview.loosen', { count: impact.addedCapabilities.length })
      : impact.direction === 'tighten'
        ? t('access.preview.tighten', { count: impact.removedCapabilities.length })
        : t('access.preview.neutral');

  return (
    <div
      className={clsx(
        'rounded px-2 py-1.5 text-[11px]',
        impact.direction === 'loosen'
          ? 'bg-amber-50 text-amber-900'
          : impact.direction === 'tighten'
            ? 'bg-emerald-50 text-emerald-900'
            : 'bg-slate-50 text-slate-600',
      )}
    >
      <p className="font-medium">{headline}</p>

      {impact.warnings.length > 0 && (
        <ul className="mt-1 list-disc pl-4">
          {impact.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {impact.removedCapabilities.length > 0 && (
        <p className="mt-1">
          {t('access.preview.removed')}{colon()}{joinList(impact.removedCapabilities)}
        </p>
      )}

      {impact.affectedResources.length > 0 && (
        <p className="mt-1">
          {t('access.preview.resources', { refs: joinList(impact.affectedResources) })}
        </p>
      )}
    </div>
  );
}
