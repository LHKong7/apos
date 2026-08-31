import { useT } from '../../lib/i18n';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { relativeTime, joinList, integrationCategoryLabel } from '../../lib/format';
import { CardSkeleton, EmptyState, ErrorState } from '../../components/states';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import { useAuthStore } from '../../stores/auth';
import { CapabilityPanel } from '../Agents/CapabilityPanel';
import { SotPanel } from './SotPanel';
import { ConflictPanel } from './ConflictPanel';
import { NotificationPanel } from './NotificationPanel';
import type { IntegrationRow, IntegrationsResponse } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { WhatIsThis } from './primitives';

const CATEGORY_ICONS: Record<string, string> = {
  code: '💻',
  project_management: '📋',
  communication: '💬',
  data_system: '🗄',
};

const CATEGORY_ORDER = ['code', 'project_management', 'communication'];

/**
 * Project integration settings (page doc 14) / 项目集成设置。
 *
 * ★ It has to answer four questions: which systems are connected, which
 *   direction data syncs, where notifications go, and what the connection was
 *   granted. The first three are features; the fourth is why this page exists —
 *   an integration whose boundary you cannot see amounts to handing an external
 *   system write access and then never looking again.
 *
 *   要回答四个问题：连了哪些系统、数据往哪个方向同步、通知发到哪里、
 *   连接授予了什么权限。第四个才是这一页存在的理由。
 *
 * ★ So every card lists what is allowed **and what is denied** (§5.1) — the
 *   same principle as 08 Agent Workspace: what the user usually needs to
 *   confirm is that this connection **cannot** merge their code, and a list of
 *   allowed items alone cannot answer that.
 */
export function IntegrationsPage() {
  const t = useT();
  const { projectId } = useParams<{ projectId: string }>();
  const userId = useAuthStore((s) => s.userId);

  const q = useQuery({
    queryKey: qk.integrations(projectId!),
    queryFn: () => api.integrations(projectId!),
    enabled: Boolean(projectId) && Boolean(userId),
  });

  const runtimes = useQuery({ queryKey: qk.runtimes(), queryFn: () => api.runtimes() });

  if (!projectId) return null;

  const data = q.data;
  const perms = data?.permissions;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">{t('integ.title')}</h1>
          <Link
            to={`/projects/${projectId}`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            {t('agents.backToOverview')}
          </Link>
          {data && (
            <span className="ml-auto text-[11px] text-slate-500">
              {t('integ.connectedCount', { count: data.integrations.length })}{' '}
              {data.integrations.some((i) => i.status !== 'active') && (
                <span className="ml-1 text-amber-700">
                  {t('integ.unhealthyCount', {
                    count: data.integrations.filter((i) => i.status !== 'active').length,
                  })}
                </span>
              )}
              {data.conflictBacklog > 0 && (
                <span className="ml-1 text-amber-700">{t('integ.conflicts', { count: data.conflictBacklog })}</span>
              )}
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-3">
        <div className="mx-auto max-w-4xl space-y-3">
            {/*
              ★ This page speaks domain vocabulary (Policy / roles / integrations
                / members and grants) — precise to whoever wrote it, a wall to a
                project manager. The opening line answers "does this concern me"
                first (issue #42).
            */}
            <WhatIsThis storageKey="integrations" title={t('whatIs.integrations.title')}>
              <p>{t('whatIs.integrations.p1')}</p>
              <p>{t('whatIs.integrations.p2')}</p>
              <p>{t('whatIs.integrations.p3')}</p>
            </WhatIsThis>
          {q.isPending && <CardSkeleton />}
          {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}

          {data && <ConflictPanel projectId={projectId} canResolve={perms!.resolve_conflict} />}

          {data && data.integrations.length === 0 && (
            <EmptyState
              icon="🔌"
              message={t('integ.empty')}
              hint={t('integ.emptyHint')}
            />
          )}

          {data &&
            CATEGORY_ORDER.map((cat) => {
              const rows = data.integrations.filter((i) => i.category === cat);
              const addable = data.available.filter((a) => a.category === cat);
              if (rows.length === 0 && addable.length === 0) return null;

              return (
                <section key={cat} className="space-y-2">
                  <h2 className="text-xs font-medium text-slate-600">
                    {CATEGORY_ICONS[cat]} {integrationCategoryLabel(cat)}
                  </h2>
                  {rows.map((r) => (
                    <IntegrationCard
                      key={r.id}
                      row={r}
                      meta={data}
                      projectId={projectId}
                      perms={perms!}
                    />
                  ))}
                  {addable.length > 0 && (
                    <AddRow options={addable} projectId={projectId} canConnect={perms!.connect} />
                  )}
                </section>
              );
            })}

          {/* ── Agents and models (§5.4) ── */}
          <section className="space-y-2">
            <h2 className="text-xs font-medium text-slate-600">{t('integ.agentsSection')}</h2>
            {runtimes.data?.runtimes.length === 0 && (
              <p className="rounded border border-dashed border-slate-300 bg-white px-3 py-2 text-[11px] text-slate-500">
                {t('integ.noRuntimes')}
              </p>
            )}
            {runtimes.data?.runtimes.map((rt) => (
              <div key={rt.id} className="space-y-1.5">
                <div className="rounded border border-slate-200 bg-white px-3 py-2">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm text-slate-900">{rt.name}</span>
                    <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-600">
                      {rt.kind}
                    </span>
                    <span
                      className={clsx(
                        'text-[11px]',
                        rt.registered && rt.reachable ? 'text-green-700' : 'text-amber-700',
                      )}
                    >
                      ● {rt.registered && rt.reachable ? t('integ.dispatchable') : rt.registered ? t('integ.unreachable') : t('integ.unregistered')}
                    </span>
                    <Link
                      to={`/projects/${projectId}/agents`}
                      className="ml-auto text-[11px] text-slate-500 underline-offset-2 hover:underline"
                    >
                      {t('integ.manageAgents')}
                    </Link>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {rt.agentCount === 0
                      ? t('integ.noAgentUses')
                      : t('integ.agentsUsing', { count: rt.agentCount, names: joinList(rt.agentNames) })}
                  </p>
                  {!rt.registered && (
                    <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                      {t('integ.adapterUnregistered')}
                    </p>
                  )}
                </div>
                {rt.capability && <CapabilityPanel report={rt.capability} runtimeName={rt.name} />}
              </div>
            ))}
          </section>

          {/**
           * ★ Enterprise data systems: product doc 13 explicitly defers full ERP
           *   / CRM integration. This is a placeholder note plus a pointer to
           *   the organization level — no clickable "Connect" button that would
           *   promise something that does not exist yet.
           */}
          <section className="space-y-2">
            <h2 className="text-xs font-medium text-slate-600">{t('integ.dataSection')}</h2>
            <div className="rounded border border-dashed border-slate-300 bg-white px-3 py-2">
              <p className="text-[11px] text-slate-500">
                {t('integ.dataConnectorsNote')}
              </p>
              {perms && !perms.configure_data_connector && (
                <p className="mt-1 text-[11px] text-slate-400">
                  {t('integ.dataConnectorsNeedAdmin')}
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function IntegrationCard({
  row,
  meta,
  projectId,
  perms,
}: {
  row: IntegrationRow;
  meta: IntegrationsResponse;
  projectId: string;
  perms: IntegrationsResponse['permissions'];
}) {
  const t = useT();
  const qc = useQueryClient();
  const [disconnecting, setDisconnecting] = useState(false);

  const sync = useMutation({
    mutationFn: () => api.runIntegrationSync(row.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.integrations(projectId) });
      void qc.invalidateQueries({ queryKey: qk.syncConflicts(projectId) });
    },
  });

  const stats = row.stats as Record<string, number>;

  return (
    <div
      className={clsx(
        'rounded border bg-white',
        row.status === 'active' ? 'border-slate-200' : 'border-red-200',
      )}
    >
      <div className="flex flex-wrap items-baseline gap-2 px-3 py-2">
        <span className="text-sm text-slate-900">{row.providerLabel}</span>
        <span className="text-xs text-slate-500">{row.displayName}</span>
        <span
          className={clsx(
            'text-[11px]',
            row.status === 'active' ? 'text-green-700' : 'text-red-700',
          )}
        >
          ● {row.status === 'active' ? t('integ.status.ok') : row.status === 'paused' ? t('integ.status.paused') : t('integ.status.error')}
        </span>
        {row.conflictCount > 0 && (
          <span className="text-[11px] text-amber-700">{t('integ.syncConflicts', { count: row.conflictCount })}</span>
        )}
        <span className="text-[11px] text-slate-400">
          {row.lastSyncAt ? t('integ.lastSync', { time: relativeTime(row.lastSyncAt) }) : t('integ.notSynced')}
        </span>

        <div className="ml-auto flex gap-1.5">
          {/* ★ Only integrations that actually sync fields get this button. A
              notification channel has neither field mappings nor linked objects,
              so a "Sync now" that does nothing when clicked would read as broken */}
          {row.syncMappings.length > 0 && (
            <Button variant="outline" size="xs"
              disabled={sync.isPending || !row.transportReady}
              onClick={() => sync.mutate()}>
              {sync.isPending ? t('integ.syncing') : t('integ.syncNow')}
            </Button>
          )}
          {perms.disconnect && (
            <Button variant="outline" size="xs"
              onClick={() => setDisconnecting(true)}>
              {t('integ.disconnect')}
            </Button>
          )}
        </div>
      </div>

      {row.statusReason && (
        <p className="mx-3 mb-2 rounded bg-red-50 px-2 py-1 text-[11px] text-red-800">
          {row.statusReason}
        </p>
      )}

      {/**
       * ★ An unimplemented transport has to be stated, and kept distinct from
       *   "misconfigured". Both look like "sync is stuck" on screen, but one
       *   means go find an admin and the other means wait for a release — blur
       *   them together and the user just retries forever.
       */}
      {!row.transportReady && (
        <p className="mx-3 mb-2 rounded bg-slate-100 px-2 py-1 text-[11px] text-slate-600">
          {t('integ.transportNotReady', { provider: row.providerLabel })}
        </p>
      )}

      <div className="border-t border-slate-100 px-3 py-1.5">
        {/* ★ List both what is allowed and what is denied (§5.1) */}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
          <span className="text-slate-500">{t('integ.permissions')}</span>
          {row.scopes.allowed.map((s) => (
            <span key={s} className="text-slate-700">
              ✓ {s}
            </span>
          ))}
          {row.scopes.denied.map((s) => (
            <span key={s} className="text-red-700">
              ✗ {s}
            </span>
          ))}
        </div>
        {/* ★ "We do not know" and "there genuinely is none" must not look alike */}
        {row.scopes.probed === false && (
          <p className="mt-0.5 text-[11px] text-amber-700">
            {t('integ.scopesUnprobed')}
          </p>
        )}
        {/* Wording follows the category — "merge code" under a Slack card just reads as copy-pasted text */}
        <p className="mt-0.5 text-[11px] text-slate-400">
          {t('integ.denyHardcoded')}
          {row.category === 'code'
            ? t('integ.denyMerge')
            : row.category === 'project_management'
              ? t('integ.denyDestructive')
              : t('integ.denyWorkspace')}
        </p>

        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-slate-500">
          {row.credentialHint && <span>{t('integ.credential', { hint: row.credentialHint })}</span>}
          {row.credentialExpiringSoon && (
            <span className="text-amber-700">{t('integ.credentialExpiring')}</span>
          )}
          <span>{t('integ.linkedItems', { count: row.linkedItems })}</span>
          {typeof stats['syncRuns'] === 'number' && (
            <span>{t('integ.syncRuns', { count: stats['syncRuns'] })}</span>
          )}
          {/* ★ §11: "the page shows N loop syncs blocked" */}
          {typeof stats['echoesBlocked'] === 'number' && stats['echoesBlocked'] > 0 && (
            <span title={t('integ.loopGuarded')}>
              {t('integ.echoesBlocked', { count: String(stats['echoesBlocked']) })}
            </span>
          )}
        </div>
      </div>

      {sync.data && (
        <p className="mx-3 mb-2 rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-600">
          {t('integ.syncSummary', {
            objects: sync.data.objects,
            accepted: sync.data.accepted,
            writtenBack: sync.data.writtenBack,
            conflicts: sync.data.conflicts,
            autoResolved: sync.data.autoResolved,
            echoesBlocked: sync.data.echoesBlocked,
          })}
          {sync.data.notes.map((n) => (
            <span key={n} className="mt-0.5 block text-amber-800">
              {n}
            </span>
          ))}
        </p>
      )}
      {sync.error && (
        <p className="mx-3 mb-2 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {sync.error instanceof ApiError ? sync.error.message : t('integ.syncFailed')}
        </p>
      )}

      {row.syncMappings.length > 0 && (
        <SotPanel integration={row} meta={meta} canEdit={perms.change_sot} />
      )}

      {row.notificationConfig && (
        <NotificationPanel
          integration={row}
          meta={meta}
          projectId={projectId}
          canEdit={perms.configure_notification}
        />
      )}

      {disconnecting && (
        <DisconnectDialog row={row} projectId={projectId} onClose={() => setDisconnecting(false)} />
      )}
    </div>
  );
}

/**
 * The disconnect confirmation / 断开确认。
 *
 * ★ Fetch the impact before letting anyone click (§7). "After disconnecting, 5
 *   work items stop syncing status and 2 unresolved conflicts disappear with
 *   it" — a dialog that only asks "are you sure?" asks nothing at all, because
 *   the user pressing confirm has no idea what they are giving up.
 */
function DisconnectDialog({
  row,
  projectId,
  onClose,
}: {
  row: IntegrationRow;
  projectId: string;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const impact = useQuery({
    queryKey: ['disconnectImpact', row.id],
    queryFn: () => api.disconnectImpact(row.id),
  });

  const cut = useMutation({
    mutationFn: () => api.disconnectIntegration(row.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.integrations(projectId) });
      void qc.invalidateQueries({ queryKey: qk.syncConflicts(projectId) });
      onClose();
    },
  });

  return (
    <Modal onClose={onClose} title={t('integ.disconnect')}>
      <h2 className="mb-1.5 text-sm font-semibold text-slate-900">{t('integ.disconnectNamed', { provider: row.providerLabel })}</h2>
      {impact.isPending && <p className="text-xs text-slate-500">{t('integ.checkingImpact')}</p>}
      {impact.data && (
        <>
          <p className="text-xs text-slate-600">{t('integ.afterDisconnect')}</p>
          <ul className="mt-1 space-y-0.5">
            {impact.data.effects.map((e) => (
              <li key={e} className="text-xs text-amber-800">
                · {e}
              </li>
            ))}
          </ul>
        </>
      )}

      {cut.error && (
        <p className="mt-1.5 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {cut.error instanceof ApiError ? cut.error.message : t('integ.disconnectFailed')}
        </p>
      )}

      <div className="mt-2 flex gap-1.5">
        <Button variant="destructive" size="sm"
          disabled={cut.isPending || impact.isPending}
          onClick={() => cut.mutate()}>
          {cut.isPending ? t('integ.disconnecting') : t('integ.confirmDisconnect')}
        </Button>
        <Button variant="ghost" onClick={onClose} className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-xs text-slate-500 hover:text-slate-700">
          {t('common.cancel')}
        </Button>
      </div>
    </Modal>
  );
}

function AddRow({
  options,
  projectId,
  canConnect,
}: {
  options: IntegrationsResponse['available'];
  projectId: string;
  canConnect: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [credential, setCredential] = useState('');
  const [grantWrite, setGrantWrite] = useState(false);

  const connect = useMutation({
    mutationFn: () =>
      api.connectIntegration(projectId, {
        provider: open!,
        displayName,
        credential: credential || null,
        grantWrite,
      }),
    onSuccess: () => {
      setOpen(null);
      setDisplayName('');
      setCredential('');
      setGrantWrite(false);
      void qc.invalidateQueries({ queryKey: qk.integrations(projectId) });
    },
  });

  if (!canConnect) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <Button variant="ghost"
          key={o.provider}
          onClick={() => {
            setOpen(o.provider);
            setDisplayName('');
          }}
          className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent rounded border border-dashed border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:border-slate-400"
        >
          + {o.label}
          {!o.transportReady && <span className="ml-1 text-slate-400">{t('integ.noTransport')}</span>}
        </Button>
      ))}

      {open && (
        <Modal onClose={() => setOpen(null)} title={t('integ.connect')}>
          <h2 className="mb-1.5 text-sm font-semibold text-slate-900">
            {t('integ.connectTo', {
              provider: options.find((o) => o.provider === open)?.label ?? '',
            })}
          </h2>
          <Label className="block">
            <span className="mb-0.5 block text-[11px] text-slate-500">{t('integ.target')}</span>
            <Input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="order-service" />
          </Label>

          <Label className="mt-1.5 block">
            <span className="mb-0.5 block text-[11px] text-slate-500">
              {t('integ.credentialOptional')}
            </span>
            <Input
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)} />
            {/* ★ Say where it goes. Anyone handing over a credential is entitled to know how it is stored */}
            <span className="mt-0.5 block text-[11px] text-slate-400">
              {t('integ.credentialStorage')}
            </span>
          </Label>

          <Label className="mt-1.5 flex items-start gap-1.5 text-[11px] text-slate-600">
            <Checkbox checked={grantWrite} onCheckedChange={setGrantWrite} className="mt-0.5" />
            <span>
              {t('integ.grantWrite')}
              <span className="ml-1 text-slate-400">
                {t('integ.grantWriteHint')}
              </span>
            </span>
          </Label>

          {connect.error && (
            <p className="mt-1.5 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
              {connect.error instanceof ApiError ? connect.error.message : t('integ.connectFailed')}
            </p>
          )}

          <div className="mt-2 flex gap-1.5">
            <Button variant="neutral" size="sm"
              disabled={!displayName.trim() || connect.isPending}
              onClick={() => connect.mutate()}>
              {connect.isPending ? t('integ.testing') : t('integ.testAndSave')}
            </Button>
            <Button variant="ghost"
              onClick={() => setOpen(null)}
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
