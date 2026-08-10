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
import type {
  AgentAdminRow,
  ConfigField,
  ConventionRow,
  CredentialUsageRow,
  RepositoryRow,
  RuntimeKindSpec,
} from '../../lib/api/types';

/**
 * Agent 配置（页面文档 08 §5.5）。
 *
 * ★ Agent 是一等对象，运行时是它的一个属性 —— 没有单独的「接入」层。
 *   建 N 个 Agent 就是 N 套独立配置：CLI 类型、该 CLI 的参数、凭证、
 *   权限、成本上限全在一张表里填完，不用先去别处建接入再回来挂。
 *
 * ★ 每种 CLI 能配什么由**平台**定义（contracts 的 RUNTIME_KIND_SPECS），
 *   这里按它动态渲染表单。加一种 CLI 只改那一个文件，界面自动长出字段。
 *
 * ★ 凭证输入框只在**新建或轮换**时出现，且永远不回显原值 ——
 *   一个能从界面读出 token 的系统，早晚会有人把它截图发出去。
 */

type Tab = 'agents' | 'repositories' | 'conventions';

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: 'agents', label: 'Agents', hint: '建 N 个 Agent，每个自带 CLI 类型与它的个性化配置' },
  { key: 'repositories', label: '代码仓库', hint: 'Agent 的仓库授权指向哪里' },
  { key: 'conventions', label: '工程约定', hint: '本项目所有 Agent 都要遵守的规范' },
];

export function AgentConfigPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [tab, setTab] = useState<Tab>('agents');
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
        {tab === 'agents' && <AgentsSection />}
        {tab === 'repositories' && <RepositoriesSection projectId={projectId} />}
        {tab === 'conventions' && <ConventionsSection projectId={projectId} />}
      </div>
    </div>
  );
}

// ── Agents ────────────────────────────────────────────────────────────

function AgentsSection() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<AgentAdminRow | 'new' | null>(null);

  const q = useQuery({ queryKey: qk.adminAgents(), queryFn: api.adminAgents });
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.adminAgents() });

  const probe = useMutation({ mutationFn: (id: string) => api.probeAgent(id), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteAgent(id), onSuccess: invalidate });

  if (q.isLoading) return <CardSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data!;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-xs text-slate-500">
          每个 Agent 自带一种 headless CLI 与它的个性化配置。同一种 CLI 可以建多个 Agent，各配各的。
        </p>
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="ml-auto rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
        >
          + 新建 Agent
        </button>
      </div>

      {!data.canStoreInlineCredential && (
        <Notice tone="warning">
          未配置 <code>APOS_SECRET_KEY</code>，无法保存直接粘贴的凭证。
          请用 <code>env:变量名</code> 的形式，把凭证放在进程环境里。
        </Notice>
      )}

      {data.credentialUsage.length > 0 && <CredentialUsage rows={data.credentialUsage} />}

      {data.agents.length === 0 ? (
        <EmptyState
          icon="🤖"
          message="还没有任何 Agent"
          hint="建一个 Agent 才能派发任务。可以先用「内存运行时」跑通流程，不花钱"
          action={{ label: '新建 Agent', onClick: () => setEditing('new') }}
        />
      ) : (
        <div className="space-y-2">
          {data.agents.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              spec={data.kinds.find((k) => k.kind === a.runtimeKind) ?? null}
              onProbe={() => probe.mutate(a.id)}
              onEdit={() => setEditing(a)}
              onDelete={() => remove.mutate(a.id)}
              error={remove.error}
              probing={probe.isPending}
            />
          ))}
        </div>
      )}

      {editing && (
        <AgentForm
          kinds={data.kinds}
          canStoreInline={data.canStoreInlineCredential}
          credentialHelp={data.credentialHelp}
          agent={editing === 'new' ? null : editing}
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

/**
 * ★ 取消接入层之后，「这把凭证被谁在用」失去了天然的答案位置。
 *   这块把它补回来 —— 轮换前能一眼看到要动几个 Agent，
 *   以及为什么 env: 形态只用动一处。
 */
function CredentialUsage({ rows }: { rows: CredentialUsageRow[] }) {
  const multi = rows.filter((r) => r.rotationCost !== 'one_place' && r.agents.length > 1);

  return (
    <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
      <p className="text-[11px] font-medium text-slate-700">凭证使用情况</p>
      <div className="mt-1 space-y-0.5">
        {rows.map((r) => (
          <div key={r.hint ?? '—'} className="flex flex-wrap items-center gap-2 text-[11px]">
            <code className="rounded bg-white px-1.5 py-0.5 text-slate-700">{r.hint}</code>
            <span className="text-slate-500">{r.agents.join('、')}</span>
            <span
              className={clsx(
                'rounded px-1.5 py-0.5',
                r.rotationCost === 'one_place'
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-amber-50 text-amber-800',
              )}
            >
              {r.rotationCost === 'one_place'
                ? '轮换只需改环境变量'
                : `轮换要改 ${r.agents.length} 处`}
            </span>
          </div>
        ))}
      </div>
      {multi.length > 0 && (
        <p className="mt-1 text-[11px] text-amber-800">
          ⚠ 有内联凭证被多个 Agent 各存一份，轮换时漏改一处会让那个 Agent 静默失效。
          改用 <code>env:变量名</code> 可以让它们共用一处。
        </p>
      )}
    </div>
  );
}

function AgentCard({
  agent,
  spec,
  onProbe,
  onEdit,
  onDelete,
  error,
  probing,
}: {
  agent: AgentAdminRow;
  spec: RuntimeKindSpec | null;
  onProbe: () => void;
  onEdit: () => void;
  onDelete: () => void;
  error: unknown;
  probing: boolean;
}) {
  const [showCaps, setShowCaps] = useState(false);

  /**
   * ★ 三种「不可用」分开显示。
   *   混成一句「不可用」，用户不知道该去装依赖、换 key，还是换个 Agent。
   */
  const health = !agent.registered
    ? { tone: 'error' as const, text: agent.problem ?? '适配器未在本进程注册' }
    : !agent.credentialUsable && agent.credentialHint
      ? { tone: 'error' as const, text: agent.credentialProblem ?? '凭证不可用' }
      : !agent.reachable
        ? { tone: 'warning' as const, text: agent.problem ?? '能力探测失败' }
        : { tone: 'ok' as const, text: '就绪' };

  /** 只展示与默认值不同的配置 —— 全列一遍会淹没真正被改过的那几项 */
  const overrides = spec
    ? spec.fields.filter(
        (f) =>
          agent.runtimeConfig[f.key] !== undefined &&
          JSON.stringify(agent.runtimeConfig[f.key]) !== JSON.stringify(f.default),
      )
    : [];

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-900">{agent.name}</span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
          {agent.runtimeKindLabel}
        </span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
          {agent.type}
        </span>
        <StatusDot tone={health.tone} label={health.text} />
        {agent.status !== 'active' && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
            {agent.status === 'paused' ? '已暂停' : '已停用'}
          </span>
        )}
        {agent.capability?.restricted && (
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
            onClick={onEdit}
            className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
          >
            编辑
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
          {agent.credentialHint ? (
            <span className={agent.credentialUsable ? '' : 'text-rose-600'}>
              {agent.credentialHint}
            </span>
          ) : (
            <span className="text-slate-400">未配置</span>
          )}
        </Field>
        <Field label="并发 / 超时">
          {agent.maxConcurrency} · {Math.round(agent.timeoutSeconds / 60)} 分钟
        </Field>
        <Field label="单次成本上限">
          {agent.costLimitPerRun === null ? '—' : `$${agent.costLimitPerRun}`}
        </Field>
        <Field label="最近探测">{agent.lastCheckAt ? relativeTime(agent.lastCheckAt) : '—'}</Field>
      </dl>

      {overrides.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {overrides.map((f) => (
            <span
              key={f.key}
              className={clsx(
                'rounded px-1.5 py-0.5 text-[11px]',
                f.impact === 'cost'
                  ? 'bg-amber-50 text-amber-800'
                  : f.impact === 'safety'
                    ? 'bg-rose-50 text-rose-700'
                    : 'bg-slate-100 text-slate-600',
              )}
              title={f.help}
            >
              {f.label}: {formatValue(agent.runtimeConfig[f.key])}
            </span>
          ))}
        </div>
      )}

      {error instanceof ApiError && <p className="mt-2 text-[11px] text-rose-600">{error.message}</p>}

      {agent.capability && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowCaps((v) => !v)}
            className="text-[11px] text-slate-500 underline hover:text-slate-700"
          >
            {showCaps ? '收起能力清单' : `能力清单（${agent.capability.missing.length} 项缺失）`}
          </button>
          {showCaps && (
            <div className="mt-2 space-y-1">
              {/*
                ★ 不静默降级：缺什么能力、会有什么影响，全部摊开。
                  用户在派高风险任务之前有权知道「这个 Agent 的暂停其实是终止」。
              */}
              {agent.capability.missing.length === 0 ? (
                <p className="text-[11px] text-emerald-700">能力完整，无降级项</p>
              ) : (
                agent.capability.missing.map((m) => (
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

function AgentForm({
  kinds,
  canStoreInline,
  credentialHelp,
  agent,
  onClose,
  onDone,
}: {
  kinds: RuntimeKindSpec[];
  canStoreInline: boolean;
  credentialHelp: string;
  agent: AgentAdminRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const users = useQuery({ queryKey: qk.users(), queryFn: api.users, staleTime: Infinity });
  const currentUser = useAuthStore((s) => s.userId);

  const [kind, setKind] = useState(agent?.runtimeKind ?? kinds[0]?.kind ?? 'mock');
  const [name, setName] = useState(agent?.name ?? '');
  const [type, setType] = useState(agent?.type ?? 'code');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [credential, setCredential] = useState('');
  const [endpoint, setEndpoint] = useState(agent?.endpoint ?? '');
  const [ownerId, setOwnerId] = useState(agent?.ownerId ?? currentUser ?? '');
  const [skills, setSkills] = useState((agent?.skills ?? []).join(', '));
  const [allowedTools, setAllowedTools] = useState(
    (agent?.permissions.allowedTools ?? ['Read', 'Grep']).join(', '),
  );
  const [deniedTools, setDeniedTools] = useState((agent?.permissions.deniedTools ?? []).join(', '));
  const [repoRef, setRepoRef] = useState(
    agent?.permissions.resourceScopes.find((s) => s.kind === 'repo')?.ref ?? '',
  );
  const [repoAccess, setRepoAccess] = useState(
    agent?.permissions.resourceScopes.find((s) => s.kind === 'repo')?.access ?? 'read',
  );
  const [reason, setReason] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const spec = kinds.find((k) => k.kind === kind);

  /**
   * ★ 换 CLI 类型时把配置重置成新类型的默认值，而不是保留旧值。
   *   旧 kind 的参数在新 kind 下多半不合法，留着只会让表单显示一堆
   *   保存时才报错的字段。
   */
  const [config, setConfig] = useState<Record<string, unknown>>(agent?.runtimeConfig ?? {});
  const switchKind = (next: string) => {
    setKind(next);
    setConfig(agent?.runtimeKind === next ? (agent.runtimeConfig ?? {}) : {});
  };

  const valueOf = (f: ConfigField) => (config[f.key] !== undefined ? config[f.key] : f.default);
  const setField = (key: string, v: unknown) => setConfig((c) => ({ ...c, [key]: v }));

  const save = useMutation<unknown, Error, void>({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name,
        type,
        description: description.trim() || null,
        runtimeKind: kind,
        runtimeConfig: config,
        endpoint: endpoint.trim() || null,
        ownerId,
        skills: splitList(skills),
        allowedTools: splitList(allowedTools),
        deniedTools: splitList(deniedTools),
        resourceScopes: repoRef.trim()
          ? [{ kind: 'repo', ref: repoRef.trim(), access: repoAccess }]
          : [],
        ...(credential.trim() ? { credential: credential.trim() } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      };
      return agent ? api.updateAgent(agent.id, body) : api.createAgent(body);
    },
    onSuccess: onDone,
  });

  const basicFields = (spec?.fields ?? []).filter((f) => !f.advanced);
  const advancedFields = (spec?.fields ?? []).filter((f) => f.advanced);

  return (
    <Modal onClose={onClose}>
      <div className="max-h-[75vh] space-y-3 overflow-auto pr-1">
        <h2 className="text-sm font-semibold text-slate-900">
          {agent ? `编辑 ${agent.name}` : '新建 Agent'}
        </h2>

        <div className="grid grid-cols-2 gap-2">
          <Labeled label="名称">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 refactor-agent"
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </Labeled>
          <Labeled label="类型">
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            >
              {['code', 'test', 'review', 'research', 'ops'].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Labeled>
        </div>

        <Labeled label="职责描述" help="会作为「人设」进入 prompt，帮 Agent 判断任务是否在自己擅长范围内">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="负责后端代码实现、重构与单元测试编写"
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </Labeled>

        {/* ── 运行时 ── */}
        <div className="rounded border border-slate-200 bg-slate-50 p-2">
          <p className="mb-2 text-[11px] font-medium text-slate-700">运行时</p>

          <Labeled label="Headless CLI">
            <select
              value={kind}
              onChange={(e) => switchKind(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            >
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            {spec && <p className="mt-1 text-[11px] text-slate-500">{spec.description}</p>}
            {spec?.prerequisite && (
              <p className="mt-1 text-[11px] text-amber-800">⚠ {spec.prerequisite}</p>
            )}
          </Labeled>

          {spec?.credential && (
            <Labeled label={spec.credential.label} help={credentialHelp}>
              <input
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                type="password"
                placeholder={
                  agent?.credentialHint
                    ? `当前 ${agent.credentialHint} —— 留空不改，填入则轮换`
                    : canStoreInline
                      ? 'sk-… 或 env:变量名'
                      : 'env:变量名'
                }
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
            </Labeled>
          )}

          {spec?.endpoint && (
            <Labeled label={spec.endpoint.label} help={spec.endpoint.help}>
              <input
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="https://…"
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
            </Labeled>
          )}

          {/* ★ 按平台定义的 schema 动态渲染 —— 加一种 CLI 不用改这里 */}
          {basicFields.map((f) => (
            <ConfigInput key={f.key} field={f} value={valueOf(f)} onChange={(v) => setField(f.key, v)} />
          ))}

          {advancedFields.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="mt-1 text-[11px] text-slate-500 underline hover:text-slate-700"
              >
                {showAdvanced ? '收起高级选项' : `高级选项（${advancedFields.length}）`}
              </button>
              {showAdvanced &&
                advancedFields.map((f) => (
                  <ConfigInput
                    key={f.key}
                    field={f}
                    value={valueOf(f)}
                    onChange={(v) => setField(f.key, v)}
                  />
                ))}
            </>
          )}
        </div>

        {/* ── 权限 ── */}
        <div className="rounded border border-slate-200 bg-slate-50 p-2">
          <p className="mb-2 text-[11px] font-medium text-slate-700">权限边界</p>
          <Labeled label="可用工具" help="逗号分隔。可带作用域，如 Bash(npm test:*)">
            <input
              value={allowedTools}
              onChange={(e) => setAllowedTools(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-xs"
            />
          </Labeled>
          <Labeled label="禁止工具" help="黑名单优先级高于白名单，不可被覆盖">
            <input
              value={deniedTools}
              onChange={(e) => setDeniedTools(e.target.value)}
              placeholder="如 Bash(rm *)"
              className="w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-xs"
            />
          </Labeled>
          <div className="grid grid-cols-2 gap-2">
            <Labeled label="代码仓库" help="填「代码仓库」里登记的标识">
              <input
                value={repoRef}
                onChange={(e) => setRepoRef(e.target.value)}
                placeholder="order-service"
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
            </Labeled>
            <Labeled label="仓库权限">
              <select
                value={repoAccess}
                onChange={(e) => setRepoAccess(e.target.value)}
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              >
                <option value="read">只读</option>
                <option value="write">可写</option>
              </select>
            </Labeled>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Labeled label="负责人" help="出问题时的责任人，不可为空">
            <select
              value={ownerId}
              onChange={(e) => setOwnerId(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">请选择</option>
              {(users.data?.users ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="技能标签" help="逗号分隔，用于任务匹配">
            <input
              value={skills}
              onChange={(e) => setSkills(e.target.value)}
              placeholder="TypeScript, SQL 优化"
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </Labeled>
        </div>

        {agent && (
          <Labeled label="变更原因" help="放宽权限时必填 —— 收紧不需要">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </Labeled>
        )}

        {save.error instanceof ApiError && (
          <p className="text-xs text-rose-600">{save.error.message}</p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="rounded border border-slate-300 px-3 py-1.5 text-xs">
            取消
          </button>
          <button
            type="button"
            disabled={!name.trim() || !ownerId || save.isPending}
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

/** 按 schema 渲染单个配置项。影响成本/安全的用颜色标出来 */
function ConfigInput({
  field,
  value,
  onChange,
}: {
  field: ConfigField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const badge =
    field.impact === 'cost' ? (
      <span className="rounded bg-amber-50 px-1 text-[10px] text-amber-800">影响成本</span>
    ) : field.impact === 'safety' ? (
      <span className="rounded bg-rose-50 px-1 text-[10px] text-rose-700">影响安全边界</span>
    ) : null;

  const selected = field.options?.find((o) => o.value === value);

  return (
    <Labeled label={field.label} badge={badge} help={selected?.help ?? field.help}>
      {field.type === 'select' ? (
        <select
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
        >
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : field.type === 'number' ? (
        <input
          type="number"
          value={Number(value ?? 0)}
          min={field.min}
          max={field.max}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
        />
      ) : field.type === 'boolean' ? (
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
      ) : field.type === 'string_list' ? (
        <input
          value={Array.isArray(value) ? value.join(', ') : ''}
          onChange={(e) => onChange(splitList(e.target.value))}
          placeholder="逗号分隔"
          className="w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-xs"
        />
      ) : (
        <input
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
        />
      )}
    </Labeled>
  );
}

function Labeled({
  label,
  help,
  badge,
  children,
}: {
  label: string;
  help?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="mt-2 block first:mt-0">
      <span className="flex items-center gap-1 text-xs font-medium text-slate-700">
        {label}
        {badge}
      </span>
      <div className="mt-1">{children}</div>
      {help && <p className="mt-1 text-[11px] text-slate-500">{help}</p>}
    </label>
  );
}

function splitList(v: string): string[] {
  return v
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatValue(v: unknown): string {
  if (Array.isArray(v)) return v.join('、') || '（空）';
  return String(v);
}


// ── 代码仓库 ──────────────────────────────────────────────────────────

function RepositoriesSection({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RepositoryRow | null>(null);

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
            <RepositoryCard
              key={r.id}
              repo={r}
              onDelete={() => remove.mutate(r.id)}
              onEdit={() => setEditing(r)}
              error={remove.error}
            />
          ))}
        </div>
      )}

      {(creating || editing) && (
        <RepositoryForm
          projectId={projectId}
          existing={editing}
          canStoreInline={data.canStoreInlineCredential}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onDone={() => {
            setCreating(false);
            setEditing(null);
            void qc.invalidateQueries({ queryKey: qk.repositories(projectId) });
          }}
        />
      )}
    </div>
  );
}

/**
 * 表单占位符跟着 git 地址变。
 *
 * ★ 与服务端的 resolveAuthUsername 是同一套判据，但这里只用来**提示**，
 *   真正生效的是服务端算的那份（回显在卡片上）。前端算错顶多提示不准，
 *   不会让认证行为不一致。
 */
function guessedAuthUsername(remoteUrl: string): string {
  const u = remoteUrl.toLowerCase();
  if (u.includes('github.com')) return 'x-access-token（GitHub）';
  if (u.includes('gitlab.com')) return 'oauth2（GitLab）';
  if (u.includes('bitbucket.org')) return 'x-token-auth（Bitbucket）';
  if (u.trim()) return '认不出域名 —— 自建 GitLab 请填 oauth2';
  return 'x-access-token';
}

const AUTH_SOURCE_LABEL: Record<string, string> = {
  explicit: '手动指定',
  host: '按域名推断',
  default: '兜底默认值',
};

function RepositoryCard({
  repo,
  onDelete,
  onEdit,
  error,
}: {
  repo: RepositoryRow;
  onDelete: () => void;
  onEdit: () => void;
  error: unknown;
}) {
  const probe = useMutation({ mutationFn: () => api.probeRepository(repo.id) });
  const result = probe.data;

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
        <div className="ml-auto flex gap-1.5">
          {/*
            ★ 「测试连接」是这张卡片上最该有的按钮。
              没有它，验证凭证的唯一办法是派一个任务，然后看它以
              「准备工作区失败：… 401」告终 —— 那条报错分不清是
              token 过期、scope 不够，还是用户名占位不对。
          */}
          <button
            type="button"
            onClick={() => probe.mutate()}
            disabled={probe.isPending}
            className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {probe.isPending ? '测试中…' : '测试连接'}
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50"
          >
            编辑
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
        <Field label="远端">{repo.remoteUrl}</Field>
        <Field label="默认分支">{repo.defaultBranch}</Field>
        <Field label="分支前缀">{repo.branchPrefix}</Field>
        <Field label="凭证">
          {repo.credentialHint ?? <span className="text-slate-400">未配置</span>}
        </Field>
        {/*
          ★ 用户名占位要显示出来，并注明它是怎么来的。
            这一项填错就是 401，而 401 的报错里没有任何东西指向它 ——
            自建 GitLab 踩的就是这个坑。
        */}
        <Field label="凭证用户名">
          <span className={repo.authUsernameSource === 'default' ? 'text-amber-700' : ''}>
            {repo.authUsername}
          </span>
          <span className="ml-1 text-slate-400">
            （{AUTH_SOURCE_LABEL[repo.authUsernameSource]}
            {repo.authProvider ? ` · ${repo.authProvider}` : ''}）
          </span>
        </Field>
        <Field label="质量核验">
          {repo.checkCommand ? (
            <code className="text-slate-800">{repo.checkCommand}</code>
          ) : (
            <span className="text-amber-700">未配置</span>
          )}
        </Field>
      </dl>

      {repo.warnings.map((w) => (
        <p key={w} className="mt-2 text-[11px] text-amber-700">
          ⚠ {w}
        </p>
      ))}
      {repo.credentialProblem && (
        <p className="mt-1 text-[11px] text-rose-600">⚠ {repo.credentialProblem}</p>
      )}

      {result && (
        <p
          className={clsx(
            'mt-2 whitespace-pre-wrap rounded px-2 py-1 text-[11px]',
            result.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-700',
          )}
        >
          {result.ok ? '✓ ' : '✗ '}
          {result.message}
        </p>
      )}
      {probe.error instanceof ApiError && (
        <p className="mt-2 text-[11px] text-rose-600">{probe.error.message}</p>
      )}
      {error instanceof ApiError && <p className="mt-2 text-[11px] text-rose-600">{error.message}</p>}
    </div>
  );
}

function RepositoryForm({
  projectId,
  existing,
  canStoreInline,
  onClose,
  onDone,
}: {
  projectId: string;
  /** 传了就是编辑，标识与远端不可改 */
  existing?: RepositoryRow | null;
  canStoreInline: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const isEdit = Boolean(existing);
  const [form, setForm] = useState({
    ref: existing?.ref ?? '',
    name: existing?.name ?? '',
    remoteUrl: existing?.remoteUrl ?? '',
    defaultBranch: existing?.defaultBranch ?? 'main',
    branchPrefix: existing?.branchPrefix ?? 'apos/',
    // ★ 只回填手填过的那份。推断出来的值回填进去会把它「钉死」成显式值，
    //   之后换了域名也不会跟着变
    authUsername: existing?.authUsernameSource === 'explicit' ? existing.authUsername : '',
    checkCommand: existing?.checkCommand ?? '',
    credential: '',
    orgWide: existing ? existing.scope === 'organization' : false,
  });

  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const create = useMutation({
    mutationFn: () =>
      isEdit
        ? api.updateRepository(existing!.id, {
            name: form.name,
            defaultBranch: form.defaultBranch,
            branchPrefix: form.branchPrefix,
            authUsername: form.authUsername.trim() || null,
            checkCommand: form.checkCommand.trim() || null,
            // 留空 = 不改凭证（避免编辑别的字段时把凭证清掉）
            ...(form.credential.trim() ? { credential: form.credential.trim() } : {}),
          })
        : api.createRepository({
        ref: form.ref,
        name: form.name,
        remoteUrl: form.remoteUrl,
        defaultBranch: form.defaultBranch,
        branchPrefix: form.branchPrefix,
        // ★ 这两个此前一直躺在表单 state 里没被提交 ——
        //   checkCommand 因此只能改数据库才配得上，而它是
        //   reviewing 阶段唯一的真实测试数据源
        authUsername: form.authUsername.trim() || null,
        checkCommand: form.checkCommand.trim() || null,
            credential: form.credential.trim() || null,
            projectId: form.orgWide ? null : projectId,
          }),
    onSuccess: onDone,
  });

  return (
    <Modal onClose={onClose}>
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">
          {isEdit ? `编辑「${existing!.name}」` : '登记代码仓库'}
        </h2>
        <label className="block">
          <span className="text-xs font-medium text-slate-700">标识</span>
          <input
            value={form.ref}
            disabled={isEdit}
            onChange={(e) => set('ref', e.target.value)}
            placeholder="order-service"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-50 disabled:text-slate-500"
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
            disabled={isEdit}
            onChange={(e) => set('remoteUrl', e.target.value)}
            placeholder="https://github.com/acme/order-service.git"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-50 disabled:text-slate-500"
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
          <span className="text-xs font-medium text-slate-700">
            凭证用户名占位
            <span className="ml-1 font-normal text-slate-400">选填</span>
          </span>
          <input
            value={form.authUsername}
            onChange={(e) => set('authUsername', e.target.value)}
            placeholder={guessedAuthUsername(form.remoteUrl)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
          {/*
            ★ 这一项填错的表现是 401，而 401 的报错里没有任何东西指向它。
              留空能按 github.com / gitlab.com 推断出来，但**自建** GitLab
              装在 git.acme.com 上推不出来 —— 那正是最常见的部署形态。
          */}
          <p className="mt-1 text-[11px] text-slate-500">
            留空按域名推断（GitHub → <code>x-access-token</code>，GitLab →{' '}
            <code>oauth2</code>，Bitbucket → <code>x-token-auth</code>）。
            <span className="text-amber-700">自建 GitLab 推断不出来，需要手填 oauth2。</span>
          </p>
        </label>

        <label className="block">
          <span className="text-xs font-medium text-slate-700">
            质量核验命令
            <span className="ml-1 font-normal text-slate-400">选填</span>
          </span>
          <input
            value={form.checkCommand}
            onChange={(e) => set('checkCommand', e.target.value)}
            placeholder="pnpm test"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
          {/*
            ★ 不填不是「少个功能」，是 reviewing 阶段的门禁没有数据可依据。
          */}
          <p className="mt-1 text-[11px] text-slate-500">
            Agent 收工后、提交之前在工作区执行。不填的话，reviewing
            阶段的质量门禁只能依据 Agent 自述 —— 那是一句话，不是证据。
          </p>
        </label>

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
