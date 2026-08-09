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
import type { ConventionRow, RepositoryRow, RuntimeAdminRow } from '../../lib/api/types';

/**
 * Agent 配置（页面文档 08 §5.5）。
 *
 * ★ 信息架构刻意分成三块，不做成一个巨型配置页：
 *
 *   | 块 | 管什么 | 谁配 |
 *   | --- | --- | --- |
 *   | 运行时接入 | 接哪些 code agent、用哪把钥匙 | 组织管理员，一次配置 |
 *   | 代码仓库 | Agent 的 repo 授权指向哪个真实仓库 | tech lead |
 *   | 工程约定 | 编码规范、测试要求 | tech lead，按项目 |
 *
 *   揉在一起的后果很具体：加一个新 code agent 要重填一遍工具白名单和工程约定。
 *
 * ★ 凭证输入框只在**新建或轮换**时出现，且永远不回显原值 ——
 *   一个能从界面读出 token 的系统，早晚会有人把它截图发出去。
 */

type Tab = 'runtimes' | 'repositories' | 'conventions';

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: 'runtimes', label: '运行时接入', hint: '接哪些 Code Agent、用哪把钥匙' },
  { key: 'repositories', label: '代码仓库', hint: 'Agent 的仓库授权指向哪里' },
  { key: 'conventions', label: '工程约定', hint: '本项目所有 Agent 都要遵守的规范' },
];

export function AgentConfigPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [tab, setTab] = useState<Tab>('runtimes');
  const userId = useAuthStore((s) => s.userId);

  if (!projectId || !userId) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">Agent 配置</h1>
          <Link to={`/projects/${projectId}`} className="text-xs text-slate-500 hover:text-slate-700">
            ← 项目总览
          </Link>
        </div>
        <div className="mt-2 flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              title={t.hint}
              className={clsx(
                'rounded px-3 py-1 text-xs font-medium',
                tab === t.key
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {tab === 'runtimes' && <RuntimesSection />}
        {tab === 'repositories' && <RepositoriesSection projectId={projectId} />}
        {tab === 'conventions' && <ConventionsSection projectId={projectId} />}
      </div>
    </div>
  );
}

// ── 运行时接入 ────────────────────────────────────────────────────────

function RuntimesSection() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);

  const q = useQuery({ queryKey: qk.adminRuntimes(), queryFn: api.adminRuntimes });

  const probe = useMutation({
    mutationFn: (id: string) => api.probeRuntime(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.adminRuntimes() }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteRuntime(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.adminRuntimes() }),
  });

  if (q.isLoading) return <CardSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data!;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-xs text-slate-500">
          每个接入是一套「运行时 + 凭证」，可被多个 Agent 复用。
        </p>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="ml-auto rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
        >
          + 新增接入
        </button>
      </div>

      {!data.canStoreInlineCredential && (
        <Notice tone="warning">
          未配置 <code>APOS_SECRET_KEY</code>，无法保存直接粘贴的凭证。
          请用 <code>env:变量名</code> 的形式，把凭证放在进程环境里。
        </Notice>
      )}

      {data.runtimes.length === 0 ? (
        <EmptyState
          icon="🔌"
          message="还没有接入任何 Code Agent"
          hint="接入之后才能建 Agent 档案，任务也才派得出去"
          action={{ label: '新增接入', onClick: () => setCreating(true) }}
        />
      ) : (
        <div className="space-y-2">
          {data.runtimes.map((rt) => (
            <RuntimeCard
              key={rt.id}
              rt={rt}
              onProbe={() => probe.mutate(rt.id)}
              onDelete={() => remove.mutate(rt.id)}
              deleteError={remove.error}
              probing={probe.isPending}
            />
          ))}
        </div>
      )}

      {creating && (
        <RuntimeForm
          kinds={data.kinds}
          credentialHelp={data.credentialHelp}
          canStoreInline={data.canStoreInlineCredential}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            void qc.invalidateQueries({ queryKey: qk.adminRuntimes() });
          }}
        />
      )}
    </div>
  );
}

function RuntimeCard({
  rt,
  onProbe,
  onDelete,
  deleteError,
  probing,
}: {
  rt: RuntimeAdminRow;
  onProbe: () => void;
  onDelete: () => void;
  deleteError: unknown;
  probing: boolean;
}) {
  const [showCaps, setShowCaps] = useState(false);

  /**
   * ★ 三种「不可用」分开显示。
   *   混成一句「不可用」，用户不知道该去装依赖、换 key，还是换个 Agent。
   */
  const health = !rt.registered
    ? { tone: 'error' as const, text: rt.problem ?? '本进程没有这个运行时的适配器' }
    : !rt.credentialUsable && rt.credentialHint
      ? { tone: 'error' as const, text: rt.credentialProblem ?? '凭证不可用' }
      : !rt.reachable
        ? { tone: 'warning' as const, text: rt.problem ?? '能力探测失败' }
        : { tone: 'ok' as const, text: '就绪' };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-900">{rt.name}</span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
          {rt.kind}
        </span>
        <StatusDot tone={health.tone} label={health.text} />
        {rt.capability?.restricted && (
          <span
            className="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] text-rose-700"
            title="该运行时存在 critical 级能力缺失，不应用于高风险任务"
          >
            ⚠ 不适合高风险任务
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onProbe}
            disabled={probing}
            className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {probing ? '探测中…' : '重新探测'}
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded border border-slate-300 px-2 py-1 text-[11px] text-rose-600 hover:bg-rose-50"
          >
            删除
          </button>
        </div>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-600 sm:grid-cols-4">
        <Field label="凭证">
          {rt.credentialHint ? (
            <span className={rt.credentialUsable ? '' : 'text-rose-600'}>{rt.credentialHint}</span>
          ) : (
            <span className="text-slate-400">未配置</span>
          )}
        </Field>
        <Field label="使用中的 Agent">
          {rt.agentCount > 0 ? rt.agentNames.join('、') : <span className="text-slate-400">无</span>}
        </Field>
        <Field label="协议版本">{rt.protocolVersion ?? '—'}</Field>
        <Field label="最近探测">
          {rt.lastCheckAt ? relativeTime(rt.lastCheckAt) : '—'}
        </Field>
      </dl>

      {deleteError instanceof ApiError && (
        <p className="mt-2 text-[11px] text-rose-600">{deleteError.message}</p>
      )}

      {rt.capability && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowCaps((v) => !v)}
            className="text-[11px] text-slate-500 underline hover:text-slate-700"
          >
            {showCaps ? '收起能力清单' : `能力清单（${rt.capability.missing.length} 项缺失）`}
          </button>
          {showCaps && (
            <div className="mt-2 space-y-1">
              {/*
                ★ 不静默降级：缺什么能力、会有什么影响，全部摊开。
                  用户在派高风险任务之前有权知道「这个 Agent 的暂停其实是终止」。
              */}
              {rt.capability.missing.length === 0 ? (
                <p className="text-[11px] text-emerald-700">能力完整，无降级项</p>
              ) : (
                rt.capability.missing.map((m) => (
                  <div
                    key={m.feature}
                    className={clsx(
                      'rounded px-2 py-1 text-[11px]',
                      m.severity === 'critical'
                        ? 'bg-rose-50 text-rose-800'
                        : m.severity === 'warning'
                          ? 'bg-amber-50 text-amber-800'
                          : 'bg-slate-50 text-slate-600',
                    )}
                  >
                    <span className="font-medium">{m.feature}</span> · {m.behavior}
                    <span className="block text-slate-500">影响：{m.userImpact}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RuntimeForm({
  kinds,
  credentialHelp,
  canStoreInline,
  onClose,
  onDone,
}: {
  kinds: { kind: string; label: string; description: string; needsCredential: boolean; credentialLabel: string | null }[];
  credentialHelp: string;
  canStoreInline: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [kind, setKind] = useState(kinds[0]?.kind ?? 'mock');
  const [name, setName] = useState('');
  const [credential, setCredential] = useState('');
  const [endpoint, setEndpoint] = useState('');

  const spec = kinds.find((k) => k.kind === kind);

  const create = useMutation({
    mutationFn: () =>
      api.createRuntime({
        name,
        kind,
        endpoint: endpoint.trim() || null,
        credential: credential.trim() || null,
      }),
    onSuccess: onDone,
  });

  return (
    <Modal onClose={onClose}>
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">新增运行时接入</h2>
        <label className="block">
          <span className="text-xs font-medium text-slate-700">运行时类型</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          >
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          {spec && <p className="mt-1 text-[11px] text-slate-500">{spec.description}</p>}
        </label>

        <label className="block">
          <span className="text-xs font-medium text-slate-700">名称</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 claude-code-主账号"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>

        {spec?.needsCredential && (
          <label className="block">
            <span className="text-xs font-medium text-slate-700">{spec.credentialLabel}</span>
            <input
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              type="password"
              placeholder={canStoreInline ? 'sk-… 或 env:变量名' : 'env:变量名'}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
            {/* ★ 说清楚两种形态的差别，而不是等用户填完才报错 */}
            <p className="mt-1 text-[11px] text-slate-500">{credentialHelp}</p>
          </label>
        )}

        <label className="block">
          <span className="text-xs font-medium text-slate-700">接入地址（自建网关才填）</span>
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://…"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>

        {create.error instanceof ApiError && (
          <p className="text-xs text-rose-600">{create.error.message}</p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded border border-slate-300 px-3 py-1.5 text-xs">
            取消
          </button>
          <button
            type="button"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
            className="rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {create.isPending ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── 代码仓库 ──────────────────────────────────────────────────────────

function RepositoriesSection({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);

  const q = useQuery({
    queryKey: qk.repositories(projectId),
    queryFn: () => api.repositories(projectId),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteRepository(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.repositories(projectId) }),
  });

  if (q.isLoading) return <CardSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data!;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-xs text-slate-500">
          Agent 的 <code>repo</code> 资源范围按这里的「标识」解析。没登记的仓库，任务派不出去。
        </p>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="ml-auto rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
        >
          + 登记仓库
        </button>
      </div>

      {/* ★ git 环境问题在这一页说清楚，而不是等第一次派发才炸 */}
      {!data.gitAvailable && (
        <Notice tone="error">
          {data.gitProblem} —— 需要代码仓库的任务将无法派发。
        </Notice>
      )}

      {data.repositories.length === 0 ? (
        <EmptyState
          icon="📦"
          message="还没有登记任何代码仓库"
          hint="Agent 被授权的仓库必须先在这里登记，否则准备工作区时会失败"
          action={{ label: '登记仓库', onClick: () => setCreating(true) }}
        />
      ) : (
        <div className="space-y-2">
          {data.repositories.map((r) => (
            <RepositoryCard key={r.id} repo={r} onDelete={() => remove.mutate(r.id)} error={remove.error} />
          ))}
        </div>
      )}

      {creating && (
        <RepositoryForm
          projectId={projectId}
          canStoreInline={data.canStoreInlineCredential}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            void qc.invalidateQueries({ queryKey: qk.repositories(projectId) });
          }}
        />
      )}
    </div>
  );
}

function RepositoryCard({
  repo,
  onDelete,
  error,
}: {
  repo: RepositoryRow;
  onDelete: () => void;
  error: unknown;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-800">
          {repo.ref}
        </code>
        <span className="text-sm text-slate-900">{repo.name}</span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
          {repo.scope === 'project' ? '本项目' : '组织共享'}
        </span>
        <button
          type="button"
          onClick={onDelete}
          className="ml-auto rounded border border-slate-300 px-2 py-1 text-[11px] text-rose-600 hover:bg-rose-50"
        >
          删除
        </button>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-600 sm:grid-cols-4">
        <Field label="远端">{repo.remoteUrl}</Field>
        <Field label="默认分支">{repo.defaultBranch}</Field>
        <Field label="分支前缀">{repo.branchPrefix}</Field>
        <Field label="凭证">
          {repo.credentialHint ?? <span className="text-slate-400">未配置</span>}
        </Field>
      </dl>

      {repo.warning && <p className="mt-2 text-[11px] text-amber-700">⚠ {repo.warning}</p>}
      {repo.credentialProblem && (
        <p className="mt-1 text-[11px] text-rose-600">⚠ {repo.credentialProblem}</p>
      )}
      {error instanceof ApiError && <p className="mt-2 text-[11px] text-rose-600">{error.message}</p>}
    </div>
  );
}

function RepositoryForm({
  projectId,
  canStoreInline,
  onClose,
  onDone,
}: {
  projectId: string;
  canStoreInline: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    ref: '',
    name: '',
    remoteUrl: '',
    defaultBranch: 'main',
    branchPrefix: 'apos/',
    checkCommand: '',
    credential: '',
    orgWide: false,
  });

  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const create = useMutation({
    mutationFn: () =>
      api.createRepository({
        ref: form.ref,
        name: form.name,
        remoteUrl: form.remoteUrl,
        defaultBranch: form.defaultBranch,
        branchPrefix: form.branchPrefix,
        credential: form.credential.trim() || null,
        projectId: form.orgWide ? null : projectId,
      }),
    onSuccess: onDone,
  });

  return (
    <Modal onClose={onClose}>
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">登记代码仓库</h2>
        <label className="block">
          <span className="text-xs font-medium text-slate-700">标识</span>
          <input
            value={form.ref}
            onChange={(e) => set('ref', e.target.value)}
            placeholder="order-service"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
          <p className="mt-1 text-[11px] text-slate-500">
            Agent 资源范围里填的就是这个值，登记后不建议再改。
          </p>
        </label>

        <label className="block">
          <span className="text-xs font-medium text-slate-700">显示名</span>
          <input
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-slate-700">git 地址</span>
          <input
            value={form.remoteUrl}
            onChange={(e) => set('remoteUrl', e.target.value)}
            placeholder="https://github.com/acme/order-service.git"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-xs font-medium text-slate-700">默认分支</span>
            <input
              value={form.defaultBranch}
              onChange={(e) => set('defaultBranch', e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-700">分支前缀</span>
            <input
              value={form.branchPrefix}
              onChange={(e) => set('branchPrefix', e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
        </div>

        <label className="block">
          <span className="text-xs font-medium text-slate-700">访问凭证</span>
          <input
            value={form.credential}
            onChange={(e) => set('credential', e.target.value)}
            type="password"
            placeholder={canStoreInline ? 'ghp_… 或 env:变量名' : 'env:变量名'}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
          <p className="mt-1 text-[11px] text-slate-500">
            私有仓库必填，否则准备工作区时会克隆失败。
          </p>
        </label>

        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={form.orgWide}
            onChange={(e) => set('orgWide', e.target.checked)}
          />
          组织共享（其他项目也能用）
        </label>

        {create.error instanceof ApiError && (
          <p className="text-xs text-rose-600">{create.error.message}</p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded border border-slate-300 px-3 py-1.5 text-xs">
            取消
          </button>
          <button
            type="button"
            disabled={!form.ref.trim() || !form.remoteUrl.trim() || create.isPending}
            onClick={() => create.mutate()}
            className="rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {create.isPending ? '登记中…' : '登记'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── 工程约定 ──────────────────────────────────────────────────────────

function ConventionsSection({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<ConventionRow | 'new' | null>(null);

  const q = useQuery({
    queryKey: qk.conventions(projectId),
    queryFn: () => api.conventions(projectId),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.conventions(projectId) });

  const toggle = useMutation({
    mutationFn: (row: ConventionRow) => api.updateConvention(row.id, { enabled: !row.enabled }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteConvention(id),
    onSuccess: invalidate,
  });

  if (q.isLoading) return <CardSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data!;

  return (
    <div className="space-y-3">
      {/*
        ★ 必须写清楚这一层的边界，否则用户会把它当成
          「Agent 的 system prompt 文本框」来用，往里写
          「遇到问题自己想办法解决」之类会架空干预通道的话。
      */}
      <Notice tone="info">{data.notice}</Notice>

      <div className="flex items-center gap-2">
        <p className="text-xs text-slate-500">按顺序作为「必读上下文」下发给本项目所有 Agent。</p>
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="ml-auto rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
        >
          + 新增约定
        </button>
      </div>

      {data.conventions.length === 0 ? (
        <EmptyState
          icon="📐"
          message="还没有工程约定"
          hint="写下编码规范、测试要求、提交规范，Agent 每次执行都会读到"
          action={{ label: '新增约定', onClick: () => setEditing('new') }}
        />
      ) : (
        <div className="space-y-2">
          {data.conventions.map((c) => (
            <div
              key={c.id}
              className={clsx(
                'rounded-lg border bg-white p-3',
                c.enabled ? 'border-slate-200' : 'border-slate-200 opacity-60',
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-900">{c.title}</span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                  {c.priority === 'must_read' ? '必读' : '参考'}
                </span>
                {c.appliesTo.length > 0 && (
                  <span className="text-[11px] text-slate-500">
                    仅 {c.appliesTo.join('、')}
                  </span>
                )}
                <div className="ml-auto flex gap-1">
                  <button
                    type="button"
                    onClick={() => toggle.mutate(c)}
                    className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
                  >
                    {c.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(c)}
                    className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => remove.mutate(c.id)}
                    className="rounded border border-slate-300 px-2 py-1 text-[11px] text-rose-600 hover:bg-rose-50"
                  >
                    删除
                  </button>
                </div>
              </div>
              <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] text-slate-600">
                {c.content}
              </pre>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <ConventionForm
          projectId={projectId}
          row={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            void invalidate();
          }}
        />
      )}
    </div>
  );
}

function ConventionForm({
  projectId,
  row,
  onClose,
  onDone,
}: {
  projectId: string;
  row: ConventionRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(row?.title ?? '');
  const [content, setContent] = useState(row?.content ?? '');
  const [priority, setPriority] = useState(row?.priority ?? 'must_read');

  const save = useMutation({
    mutationFn: () =>
      row
        ? api.updateConvention(row.id, { title, content, priority })
        : api.createConvention(projectId, { title, content, priority, appliesTo: [] }),
    onSuccess: onDone,
  });

  return (
    <Modal onClose={onClose}>
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">{row ? '编辑工程约定' : '新增工程约定'}</h2>
        <label className="block">
          <span className="text-xs font-medium text-slate-700">标题</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="如：提交规范"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-slate-700">内容</span>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            placeholder={'如：\n- 每个提交只做一件事\n- 新增逻辑必须带单元测试\n- 不要引入新依赖，先提出来讨论'}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-xs"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-slate-700">优先级</span>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="must_read">必读（进「必读上下文」）</option>
            <option value="reference">参考（进「参考上下文」）</option>
          </select>
        </label>

        {save.error instanceof ApiError && (
          <p className="text-xs text-rose-600">{save.error.message}</p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded border border-slate-300 px-3 py-1.5 text-xs">
            取消
          </button>
          <button
            type="button"
            disabled={!title.trim() || !content.trim() || save.isPending}
            onClick={() => save.mutate()}
            className="rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {save.isPending ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── 小组件 ────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-slate-400">{label}</dt>
      <dd className="truncate text-slate-700" title={typeof children === 'string' ? children : undefined}>
        {children}
      </dd>
    </div>
  );
}

function StatusDot({ tone, label }: { tone: 'ok' | 'warning' | 'error'; label: string }) {
  return (
    <span
      className={clsx(
        'rounded px-1.5 py-0.5 text-[11px]',
        tone === 'ok'
          ? 'bg-emerald-50 text-emerald-700'
          : tone === 'warning'
            ? 'bg-amber-50 text-amber-800'
            : 'bg-rose-50 text-rose-700',
      )}
      title={label}
    >
      ● {label}
    </span>
  );
}

function Notice({ tone, children }: { tone: 'info' | 'warning' | 'error'; children: React.ReactNode }) {
  return (
    <div
      className={clsx(
        'rounded border px-3 py-2 text-[11px]',
        tone === 'info'
          ? 'border-slate-200 bg-slate-50 text-slate-600'
          : tone === 'warning'
            ? 'border-amber-200 bg-amber-50 text-amber-800'
            : 'border-rose-200 bg-rose-50 text-rose-700',
      )}
    >
      {children}
    </div>
  );
}
