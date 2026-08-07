import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { relativeTime } from '../../lib/format';
import { CardSkeleton, EmptyState, ErrorState } from '../../components/states';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import { useAuthStore } from '../../stores/auth';
import { CapabilityPanel } from '../Agents/CapabilityPanel';
import { SotPanel } from './SotPanel';
import { ConflictPanel } from './ConflictPanel';
import { NotificationPanel } from './NotificationPanel';
import type { IntegrationRow, IntegrationsResponse } from '../../lib/api/types';

const CATEGORY_ICONS: Record<string, string> = {
  code: '💻',
  project_management: '📋',
  communication: '💬',
  data_system: '🗄',
};

const CATEGORY_ORDER = ['code', 'project_management', 'communication'];

/**
 * 项目集成设置（页面文档 14）。
 *
 * ★ 要回答四个问题：连了哪些系统、数据往哪个方向同步、通知发到哪里、
 *   连接授予了什么权限。前三个是功能，第四个是这一页存在的理由 ——
 *   一个看不出边界的集成，等于把外部系统的写权限交出去之后就不再管了。
 *
 * ★ 所以每张卡片都同时列出允许项与**禁止项**（§5.1），
 *   和 08 Agent Workspace 完全同一条原则：用户需要确认的往往是
 *   「这个连接**不能**合并我的代码」，而只列允许项的清单回答不了这个问题。
 */
export function IntegrationsPage() {
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
          <h1 className="text-sm font-semibold text-slate-900">集成设置</h1>
          <Link
            to={`/projects/${projectId}`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            ← 项目总览
          </Link>
          {data && (
            <span className="ml-auto text-[11px] text-slate-500">
              已连接 {data.integrations.length}{' '}
              {data.integrations.some((i) => i.status !== 'active') && (
                <span className="ml-1 text-amber-700">
                  · ⚠ 异常 {data.integrations.filter((i) => i.status !== 'active').length}
                </span>
              )}
              {data.conflictBacklog > 0 && (
                <span className="ml-1 text-amber-700">· 冲突 {data.conflictBacklog}</span>
              )}
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-3">
        <div className="mx-auto max-w-4xl space-y-3">
          {q.isPending && <CardSkeleton />}
          {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}

          {data && <ConflictPanel projectId={projectId} canResolve={perms!.resolve_conflict} />}

          {data && data.integrations.length === 0 && (
            <EmptyState
              icon="🔌"
              message="还没有连接任何外部系统"
              hint="先连一个代码仓库和一个通知渠道，Agent 才有地方干活、你才收得到需要决策的提醒"
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
                    {CATEGORY_ICONS[cat]}{' '}
                    {rows[0]?.categoryLabel ?? addable[0]?.categoryLabel ?? cat}
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

          {/* ── Agent 与模型（§5.4）── */}
          <section className="space-y-2">
            <h2 className="text-xs font-medium text-slate-600">🤖 Agent 与模型</h2>
            {runtimes.data?.runtimes.length === 0 && (
              <p className="rounded border border-dashed border-slate-300 bg-white px-3 py-2 text-[11px] text-slate-500">
                还没有配置 Agent 运行时
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
                      ● {rt.registered && rt.reachable ? '可派发' : rt.registered ? '不可达' : '未注册'}
                    </span>
                    <Link
                      to={`/projects/${projectId}/agents`}
                      className="ml-auto text-[11px] text-slate-500 underline-offset-2 hover:underline"
                    >
                      管理 Agent →
                    </Link>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {rt.agentCount === 0
                      ? '没有 Agent 使用这个运行时'
                      : `${rt.agentCount} 个 Agent 在用：${rt.agentNames.join('、')}`}
                  </p>
                  {!rt.registered && (
                    <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                      当前进程没有注册这个运行时的适配器 —— 派给它的任务不会开始执行
                    </p>
                  )}
                </div>
                {rt.capability && <CapabilityPanel report={rt.capability} runtimeName={rt.name} />}
              </div>
            ))}
          </section>

          {/**
           * ★ 企业数据系统：产品文档十三明确「全量 ERP / CRM 集成」暂不实现。
           *   这里只做占位说明与组织级引导，不放一个能点的「连接」按钮。
           */}
          <section className="space-y-2">
            <h2 className="text-xs font-medium text-slate-600">🗄 企业数据系统</h2>
            <div className="rounded border border-dashed border-slate-300 bg-white px-3 py-2">
              <p className="text-[11px] text-slate-500">
                数据库、数据仓库、CRM 等要通过受控连接器接入，而连接器必须由组织管理员
                在组织级配置、项目只能使用已授权的那些（产品文档 10.3）。
                组织级配置页还没有做，所以这里现在什么也连不了
              </p>
              {perms && !perms.configure_data_connector && (
                <p className="mt-1 text-[11px] text-slate-400">
                  即便做好了，这一档也需要组织管理员权限
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
          ● {row.status === 'active' ? '正常' : row.status === 'paused' ? '已暂停' : '异常'}
        </span>
        {row.conflictCount > 0 && (
          <span className="text-[11px] text-amber-700">⚠ 同步冲突 {row.conflictCount}</span>
        )}
        <span className="text-[11px] text-slate-400">
          {row.lastSyncAt ? `最后同步 ${relativeTime(row.lastSyncAt)}` : '尚未同步'}
        </span>

        <div className="ml-auto flex gap-1.5">
          {/* ★ 只有真的会同步字段的集成才给这个按钮。
              通知渠道没有字段映射也没有关联对象，给一个点了什么也不发生的
              「立即同步」，用户会以为是坏的 */}
          {row.syncMappings.length > 0 && (
            <button
              type="button"
              disabled={sync.isPending || !row.transportReady}
              onClick={() => sync.mutate()}
              className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              {sync.isPending ? '同步中…' : '立即同步'}
            </button>
          )}
          {perms.disconnect && (
            <button
              type="button"
              onClick={() => setDisconnecting(true)}
              className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
            >
              断开
            </button>
          )}
        </div>
      </div>

      {row.statusReason && (
        <p className="mx-3 mb-2 rounded bg-red-50 px-2 py-1 text-[11px] text-red-800">
          {row.statusReason}
        </p>
      )}

      {/**
       * ★ 传输层没实现要说清楚，且和「配置错了」区分开。
       *   两者在界面上都表现为「同步不动」，但一个要找管理员、
       *   一个要等版本 —— 混在一起用户只会反复重试。
       */}
      {!row.transportReady && (
        <p className="mx-3 mb-2 rounded bg-slate-100 px-2 py-1 text-[11px] text-slate-600">
          {row.providerLabel} 的传输层还没有实现，配置保留但同步不会真的发生
        </p>
      )}

      <div className="border-t border-slate-100 px-3 py-1.5">
        {/* ★ 允许项与禁止项都要列（§5.1）*/}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
          <span className="text-slate-500">权限</span>
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
        {/* 措辞跟着类别走 —— 在 Slack 卡片下写「合并代码」只会让人以为文案是抄的 */}
        <p className="mt-0.5 text-[11px] text-slate-400">
          禁止项由集成层写死，不是「这次没勾」——
          {row.category === 'code'
            ? '合并代码这类操作必须经过 Policy 判定，不能由集成层直接放开'
            : row.category === 'project_management'
              ? '删除工单、改项目配置这类操作不交给自动化'
              : '管理工作区这类操作不在集成层的授权范围里'}
        </p>

        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-slate-500">
          {row.credentialHint && <span>凭证 {row.credentialHint}</span>}
          {row.credentialExpiringSoon && (
            <span className="text-amber-700">⚠ 凭证 7 天内过期，请提前重新授权</span>
          )}
          <span>关联任务 {row.linkedItems}</span>
          {typeof stats['syncRuns'] === 'number' && <span>同步 {stats['syncRuns']} 轮</span>}
          {/* ★ §11「页面显示已阻止 N 次循环同步」*/}
          {typeof stats['echoesBlocked'] === 'number' && stats['echoesBlocked'] > 0 && (
            <span title="双向同步造成的循环更新已被来源标记挡住">
              已阻止 {stats['echoesBlocked']} 次循环同步
            </span>
          )}
        </div>
      </div>

      {sync.data && (
        <p className="mx-3 mb-2 rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-600">
          同步 {sync.data.objects} 个对象：接受 {sync.data.accepted} · 回写{' '}
          {sync.data.writtenBack} · 冲突 {sync.data.conflicts} · 自动处理{' '}
          {sync.data.autoResolved} · 阻止循环 {sync.data.echoesBlocked}
          {sync.data.notes.map((n) => (
            <span key={n} className="mt-0.5 block text-amber-800">
              {n}
            </span>
          ))}
        </p>
      )}
      {sync.error && (
        <p className="mx-3 mb-2 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {sync.error instanceof ApiError ? sync.error.message : '同步失败'}
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
 * 断开确认。
 *
 * ★ 先拉影响再让人点（§7）。「断开后 5 个任务的状态不再同步、
 *   2 个未处理冲突会一并消失」—— 一个只问「确定吗」的确认框等于没问，
 *   因为用户点确定时并不知道自己在放弃什么。
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
    <Modal onClose={onClose}>
      <h2 className="mb-1.5 text-sm font-semibold text-slate-900">断开 {row.providerLabel}</h2>
      {impact.isPending && <p className="text-xs text-slate-500">正在确认影响…</p>}
      {impact.data && (
        <>
          <p className="text-xs text-slate-600">断开后会发生：</p>
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
          {cut.error instanceof ApiError ? cut.error.message : '断开失败'}
        </p>
      )}

      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          disabled={cut.isPending || impact.isPending}
          onClick={() => cut.mutate()}
          className="rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-40"
        >
          {cut.isPending ? '断开中…' : '确认断开'}
        </button>
        <button type="button" onClick={onClose} className="text-xs text-slate-500 hover:text-slate-700">
          取消
        </button>
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
        <button
          key={o.provider}
          type="button"
          onClick={() => {
            setOpen(o.provider);
            setDisplayName('');
          }}
          className="rounded border border-dashed border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:border-slate-400"
        >
          + {o.label}
          {!o.transportReady && <span className="ml-1 text-slate-400">（无传输层）</span>}
        </button>
      ))}

      {open && (
        <Modal onClose={() => setOpen(null)}>
          <h2 className="mb-1.5 text-sm font-semibold text-slate-900">
            连接 {options.find((o) => o.provider === open)?.label}
          </h2>
          <label className="block">
            <span className="mb-0.5 block text-[11px] text-slate-500">连接对象（仓库 / 项目 / 群组）</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="order-service"
              className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
            />
          </label>

          <label className="mt-1.5 block">
            <span className="mb-0.5 block text-[11px] text-slate-500">
              访问凭证（可选）
            </span>
            <input
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
            />
            {/* ★ 明说它去哪了。用户交出凭证时有权知道系统怎么保管 */}
            <span className="mt-0.5 block text-[11px] text-slate-400">
              明文不入库，只保留后四位用于辨认。保存后无法再读出
            </span>
          </label>

          <label className="mt-1.5 flex items-start gap-1.5 text-[11px] text-slate-600">
            <input
              type="checkbox"
              checked={grantWrite}
              onChange={(e) => setGrantWrite(e.target.checked)}
              className="mt-0.5 h-3 w-3"
            />
            <span>
              授予写权限
              <span className="ml-1 text-slate-400">
                让它能创建分支 / PR、修改外部工单。这是比「连上」高一个量级的授权，需要 tech_lead
              </span>
            </span>
          </label>

          {connect.error && (
            <p className="mt-1.5 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
              {connect.error instanceof ApiError ? connect.error.message : '连接失败'}
            </p>
          )}

          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              disabled={!displayName.trim() || connect.isPending}
              onClick={() => connect.mutate()}
              className="rounded bg-slate-900 px-2 py-1 text-xs text-white hover:bg-slate-700 disabled:opacity-40"
            >
              {connect.isPending ? '测试连接中…' : '测试连接并保存'}
            </button>
            <button
              type="button"
              onClick={() => setOpen(null)}
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
