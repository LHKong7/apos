import { useCallback, useEffect, useRef, useState } from 'react';
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

/**
 * Agent 配置（页面文档 08 §5.5）。
 *
 * ★ Agent 是一等对象，运行时是它的一个属性 —— 没有单独的「接入」层。
 *   建 N 个 Agent 就是 N 套独立配置：CLI 类型、该 CLI 的参数、凭证、
 *   权限、成本上限全在一张表里填完，不用先去别处建接入再回来挂。
 *
 * ★★ 运行时配置是一个**自定义 JSON 文本框**，不是一堆逐项渲染的输入框。
 *
 *   逐项表单的问题不在于难用，在于它划定了能配什么：平台的字段表一定
 *   滞后于 CLI 本身，而滞后的那几周里，界面上没有那一栏 = 这个功能不存在。
 *   接中转站、加一个上周新出的 flag，都不该等平台发版。
 *
 *   平台认识的键仍然在服务端校验（写错的值当场拒掉），不认识的键原样保存
 *   并在保存后提示 —— 它可能是你有意下发的，也可能是键名敲错了。
 *
 * ★ 每种 CLI 能配什么由**平台**定义（contracts 的 RUNTIME_KIND_SPECS），
 *   这里把它渲染成 JSON 框旁边的**说明书**：能配什么键、取值范围、默认值、
 *   哪些影响成本或安全。JSON 框里没有标签，没有这张表用户只能猜键名。
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
  /**
   * ★ 保存时平台不认识的配置键。
   *
   *   它们**已经存下来了**（配置是自定义 JSON），但仍然要说出来：
   *   「有意下发一个平台还不认识的键」和「键名敲错了」存进去的样子一样，
   *   而后者永远不会生效 —— 不提示的话，现场没有任何迹象。
   */
  const [unknownKeys, setUnknownKeys] = useState<string[]>([]);

  const q = useQuery({ queryKey: qk.adminAgents(), queryFn: api.adminAgents });
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.adminAgents() });
  const openForm = (target: AgentAdminRow | 'new') => {
    setUnknownKeys([]);
    setEditing(target);
  };

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
        <Button variant="neutral" size="sm"
          onClick={() => openForm('new')}
          className="ml-auto">
          + 新建 Agent
        </Button>
      </div>

      {/*
        ★ 这里说的是「存成什么样」，不是「能不能存」。
          没配主密钥照样能保存 —— 只是明文进库，值得知道，但不该拦着人干活。
      */}
      {!data.encryptsInlineSecrets && (
        <Notice tone="warning">
          未配置 <code>APOS_SECRET_KEY</code>：直接粘贴的凭证与 JSON 里的敏感值会
          <strong>明文</strong>存进数据库（接口仍然只回占位符，不回显）。
          想让它们密文入库就配上这个环境变量，或改用 <code>env:变量名</code> 把值留在进程环境里。
        </Notice>
      )}

      {unknownKeys.length > 0 && (
        <Notice tone="warning">
          这些键平台不认识，已按你写的原样保存：<code>{unknownKeys.join('、')}</code>。
          如果是有意下发给运行时的就不用管；如果只是键名敲错了，它永远不会生效。
        </Notice>
      )}

      {data.credentialUsage.length > 0 && <CredentialUsage rows={data.credentialUsage} />}

      {data.agents.length === 0 ? (
        <EmptyState
          icon="🤖"
          message="还没有任何 Agent"
          hint="建一个 Agent 才能派发任务。可以先用「内存运行时」跑通流程，不花钱"
          action={{ label: '新建 Agent', onClick: () => openForm('new') }}
        />
      ) : (
        <div className="space-y-2">
          {data.agents.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              spec={data.kinds.find((k) => k.kind === a.runtimeKind) ?? null}
              onProbe={() => probe.mutate(a.id)}
              onEdit={() => openForm(a)}
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
          encryptsInline={data.encryptsInlineSecrets}
          credentialHelp={data.credentialHelp}
          agent={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          /**
           * ★ 有没有认不出来的键都关闭弹窗。
           *   留着弹窗让用户「看完再关」的话，新建那次的 agent 已经建出来了，
           *   而表单还以为自己是新建态 —— 再点一次保存就是第二个 Agent。
           */
          onSaved={(keys) => {
            setEditing(null);
            setUnknownKeys(keys);
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
      : /*
         * ★ 环境变量表里解不开的引用与凭证不可用是同一类问题：
         *   配置看着完好，派发时才炸，而报错不会指向那个没设置的变量。
         */
        agent.runtimeConfigProblems.length > 0
        ? { tone: 'error' as const, text: agent.runtimeConfigProblems[0]! }
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

  /**
   * ★ 平台不认识的键也要出现在卡片上。
   *   它们同样会被下发给运行时，只是平台不知道它们是什么 —— 藏起来的话，
   *   一个键名敲错的配置在这一页看上去和干净的配置一模一样。
   */
  const customKeys = Object.keys(agent.runtimeConfig).filter(
    (k) => !(spec?.fields ?? []).some((f) => f.key === k),
  );

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
          <Button variant="outline" size="xs"
            onClick={onProbe}
            disabled={probing}>
            {probing ? '探测中…' : '重新探测'}
          </Button>
          <Button variant="outline" size="xs"
            onClick={onEdit}>
            编辑
          </Button>
          <Button variant="outline" size="xs"
            onClick={onDelete}
            className="text-rose-600 hover:bg-rose-50">
            删除
          </Button>
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
        {/*
          ★ 空的时候要**显眼地**说出来，而不是显示一个「—」。
            这个 Agent 会一直闲着，而它的凭证、探针、权限全是绿的 ——
            不在卡片上点破的话，排查会从运行时一路查到调度器。
        */}
        <Field label="承接范围">
          {agent.applicableTypes.length > 0 ? (
            agent.applicableTypes.map((t) => typeLabel(t)).join('、')
          ) : (
            <span className="text-amber-700">未设置 · 不接任何工作</span>
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

      {(overrides.length > 0 || customKeys.length > 0) && (
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
          {customKeys.map((k) => (
            <span
              key={k}
              className="rounded border border-dashed border-slate-300 px-1.5 py-0.5 font-mono text-[11px] text-slate-600"
              title="平台不认识这个键，原样保存并下发。如果只是键名敲错了，它不会生效"
            >
              {k}: {formatValue(agent.runtimeConfig[k])}
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
  encryptsInline,
  credentialHelp,
  agent,
  onClose,
  onSaved,
}: {
  kinds: RuntimeKindSpec[];
  /** 直接粘贴的敏感值是不是密文入库。两种都能存，只影响提示语 */
  encryptsInline: boolean;
  credentialHelp: string;
  agent: AgentAdminRow | null;
  onClose: () => void;
  onSaved: (unknownConfigKeys: string[]) => void;
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
  /**
   * ★★ 承接范围。空数组的含义是「什么都不接」，不是「不限制」
   *   （domain/flow/matching.ts 是 `applicableTypes.includes(target.type)` 判定）。
   *
   *   这一栏此前根本没有渲染，而后端建 Agent 时它默认是空数组 —— 于是
   *   界面上建出来的 Agent 永远接不到任何工作，也永远当不了规划 Agent，
   *   而页面上没有任何地方提示缺了什么。配置页不给的字段，用户没法自己发现。
   */
  const [applicableTypes, setApplicableTypes] = useState<string[]>(agent?.applicableTypes ?? []);
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
  /** 「可配置项」说明书默认展开：JSON 框里没有标签，收起来就没人知道该写什么 */
  const [showReference, setShowReference] = useState(true);

  const spec = kinds.find((k) => k.kind === kind);

  /**
   * ★ 换 CLI 类型时把配置重置成新类型的默认值，而不是保留旧值。
   *   旧 kind 的参数在新 kind 下多半不合法，留着只会让表单显示一堆
   *   保存时才报错的字段。
   */
  const [config, setConfig] = useState<Record<string, unknown>>(agent?.runtimeConfig ?? {});

  /**
   * ★ 哪些 JSON 文本框此刻解析不通过。
   *
   *   JSON 输入必须留在本地字符串里（边打字边解析会把还没敲完的内容毁掉），
   *   于是解析失败时 config 停在上一个合法值。不把这件事顶上来的话，
   *   用户对着一段红字报错点保存，存下去的是他改之前的那份 —— 而界面显示保存成功。
   */
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});
  const setJsonError = useCallback((key: string, message: string | null) => {
    setJsonErrors((prev) => {
      if (message === null) {
        if (!(key in prev)) return prev;
        const { [key]: _dropped, ...rest } = prev;
        return rest;
      }
      return prev[key] === message ? prev : { ...prev, [key]: message };
    });
  }, []);

  const switchKind = (next: string) => {
    setKind(next);
    setConfig(agent?.runtimeKind === next ? (agent.runtimeConfig ?? {}) : {});
    setJsonErrors({});
  };

  const save = useMutation<{ unknownConfigKeys?: string[] }, Error, void>({
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
        applicableTypes,
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
    onSuccess: (result) => onSaved(result.unknownConfigKeys ?? []),
  });

  const jsonProblem = Object.values(jsonErrors)[0] ?? null;

  return (
    <Modal
      onClose={onClose}
      title="Agent 配置"
      /* ★ 表单长，两栏也挤 —— JSON 文本框在 md 宽度下一行放不下几个字 */
      width="lg"
      footer={
        <div className="space-y-2">
          {save.error instanceof ApiError && (
            <p className="text-xs text-rose-600">{save.error.message}</p>
          )}
          {/*
            ★ JSON 解析不通过时按钮必须禁掉，而不是让它存下上一个合法值。
              「显示保存成功、存进去的是改之前那份」比直接报错难查得多。
          */}
          {jsonProblem && <p className="text-xs text-rose-600">JSON 还没改对：{jsonProblem}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button variant="neutral" size="sm"
              disabled={!name.trim() || !ownerId || save.isPending || jsonProblem !== null}
              onClick={() => save.mutate()}>
              {save.isPending ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">
          {agent ? `编辑 ${agent.name}` : '新建 Agent'}
        </h2>

        <div className="grid grid-cols-2 gap-2">
          <Labeled label="名称">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 refactor-agent" />
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
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="负责后端代码实现、重构与单元测试编写"
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
              <Input
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                type="password"
                placeholder={
                  agent?.credentialHint
                    ? `当前 ${agent.credentialHint} —— 留空不改，填入则轮换`
                    : 'sk-… 或 env:变量名'
                } />
            </Labeled>
          )}

          {spec?.endpoint && (
            <Labeled label={spec.endpoint.label} help={spec.endpoint.help}>
              <Input
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="https://…" />
            </Labeled>
          )}

          {/*
            ★★ 整份运行时配置就是这一个 JSON 框。
              平台认识的键带着默认值先摆进去（用户才知道能配什么），
              自己加的键原样保存 —— 服务端不认识也照收，只在保存后提示一句。
          */}
          <Labeled
            label="运行时配置（JSON）"
            help={
              '平台认识的键见下方「可配置项」，值写错会在保存时被拒；其余键原样保存并下发。' +
              '敏感键（含 TOKEN / KEY / SECRET / AUTH 字样）' +
              (encryptsInline ? '加密入库' : '明文入库（未配置 APOS_SECRET_KEY）') +
              '，保存后回显为 secret://saved —— 原样存回表示「这一项不改」。'
            }
          >
            <JsonInput
              /* 换 CLI 类型时重新挂载，否则文本框还留着上一种的内容 */
              key={kind}
              errorKey="__config__"
              value={withDefaults(spec, config)}
              onChange={setConfig}
              onError={setJsonError}
              rows={14}
            />
          </Labeled>

          {spec && spec.fields.length > 0 && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowReference((v) => !v)}
                className="text-[11px] text-slate-500 underline hover:text-slate-700"
              >
                {showReference ? '收起可配置项' : `可配置项（${spec.fields.length}）`}
              </button>
              {showReference && <ConfigReference fields={spec.fields} />}
            </div>
          )}

          {agent && agent.runtimeConfigProblems.length > 0 && (
            <div className="mt-2 space-y-0.5">
              {agent.runtimeConfigProblems.map((p) => (
                <p key={p} className="text-[11px] text-rose-600">
                  ⚠ {p}
                </p>
              ))}
            </div>
          )}
        </div>

        {/* ── 承接范围 ── */}
        <div className="rounded border border-slate-200 bg-slate-50 p-2">
          <p className="mb-1 text-[11px] font-medium text-slate-700">承接范围</p>
          <p className="mb-2 text-[11px] text-slate-500">
            调度器按类型匹配执行者。
            {/*
              ★ 「一个都不勾」的后果要当场说，不能等用户发现 Agent 一直闲着。
                这是这一栏被漏掉时最贵的那个症状：配置看起来是完整的。
            */}
            <span className={clsx(applicableTypes.length === 0 && 'text-amber-700')}>
              一个都不勾 = 不接任何工作
            </span>
            ；<code className="text-slate-600">需求</code> 这一项同时决定它能否承接
            需求结构化与计划生成。
          </p>
          <div className="flex flex-wrap gap-1">
            {WORK_ITEM_TYPES.map(([value, label]) => {
              const on = applicableTypes.includes(value);
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setApplicableTypes((prev) =>
                      prev.includes(value) ? prev.filter((t) => t !== value) : [...prev, value],
                    )
                  }
                  className={clsx(
                    'rounded border px-2 py-0.5 text-[11px]',
                    on
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400',
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── 权限 ── */}
        <div className="rounded border border-slate-200 bg-slate-50 p-2">
          <p className="mb-2 text-[11px] font-medium text-slate-700">权限边界</p>
          <Labeled label="可用工具" help="逗号分隔。可带作用域，如 Bash(npm test:*)">
            <Input
              value={allowedTools}
              onChange={(e) => setAllowedTools(e.target.value)}
              className="font-mono" />
          </Labeled>
          <Labeled label="禁止工具" help="黑名单优先级高于白名单，不可被覆盖">
            <Input
              value={deniedTools}
              onChange={(e) => setDeniedTools(e.target.value)}
              placeholder="如 Bash(rm *)"
              className="font-mono" />
          </Labeled>
          <div className="grid grid-cols-2 gap-2">
            <Labeled label="代码仓库" help="填「代码仓库」里登记的标识">
              <Input
                value={repoRef}
                onChange={(e) => setRepoRef(e.target.value)}
                placeholder="order-service" />
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
            <Input
              value={skills}
              onChange={(e) => setSkills(e.target.value)}
              placeholder="TypeScript, SQL 优化" />
          </Labeled>
        </div>

        {agent && (
          <Labeled label="变更原因" help="放宽权限时必填 —— 收紧不需要">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)} />
          </Labeled>
        )}
      </div>
    </Modal>
  );
}

/**
 * 13 种工作项类型（contracts 的 WorkItemType，产品文档 6.3）。
 *
 * ★ 顺序跟着 contracts 走，不按字母排 —— 那个顺序是「从需求到交付」的流程序，
 *   界面上照抄能让人一眼看出这个 Agent 站在链路的哪一段。
 */
const WORK_ITEM_TYPES: [string, string][] = [
  ['requirement', '需求'],
  ['feature', '特性'],
  ['story', '用户故事'],
  ['task', '任务'],
  ['bug', '缺陷'],
  ['research', '调研'],
  ['review', '评审'],
  ['test', '测试'],
  ['incident', '故障'],
  ['decision', '决策'],
  ['approval', '审批'],
  ['release', '发布'],
  ['knowledge', '知识'],
];

/** 认不出来的类型原样显示 —— 库里出现新类型时，显示成空白比显示英文更糟 */
function typeLabel(value: string): string {
  return WORK_ITEM_TYPES.find(([v]) => v === value)?.[1] ?? value;
}

/**
 * JSON 框里的初始内容：平台认识的键（缺的补默认值）+ 这个 Agent 自己加的键。
 *
 * ★ 已知字段要**全给**，哪怕没改过。只摊出被改过的那几项的话，
 *   这个框就成了一张白纸 —— 而它是用户唯一能看出「能配什么」的地方。
 *
 * ★ 自定义键必须原样带出来，否则「打开编辑、改个模型、保存」会把它们抹掉，
 *   而那正是接中转站的人最不能丢的那几行。
 */
function withDefaults(
  spec: RuntimeKindSpec | undefined,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (!spec) return config;
  const known = Object.fromEntries(
    spec.fields.map((f) => [f.key, f.key in config ? config[f.key] : f.default]),
  );
  const custom = Object.fromEntries(
    Object.entries(config).filter(([k]) => !spec.fields.some((f) => f.key === k)),
  );
  return { ...known, ...custom };
}

/**
 * JSON 对象输入框。
 *
 * ★ 文本留在本地 state，不是每次按键都往上抛解析结果 ——
 *   边打字边解析会在敲到一半（`{"A":` ）时判定失败，
 *   而把值重置回上一个合法对象会当场把用户正在敲的内容清掉。
 *
 * ★ 解析失败时**不**往上抛值，改为抛错误。上层据此禁用保存按钮：
 *   继续用上一个合法值保存，界面会显示成功而存进去的是旧内容。
 */
export function JsonInput({
  errorKey,
  value,
  onChange,
  onError,
  rows = 4,
}: {
  /** 这个框在表单的错误表里占的位置 */
  errorKey: string;
  value: unknown;
  onChange: (v: Record<string, unknown>) => void;
  onError: (key: string, message: string | null) => void;
  rows?: number;
}) {
  const [text, setText] = useState(() => toJsonText(value));
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * ★★ 清理副作用要走 ref，不能把 onError 放进依赖数组。
   *
   *   调用方传一个每次渲染新建的箭头函数是很自然的写法，而那会让
   *   下面这个 effect 每渲染一次就重跑一遍 cleanup —— 刚记下的错误
   *   当场被自己清掉，保存按钮永远不会被禁，于是用户对着一段红字报错
   *   点保存，存进去的是他改之前的那份，界面还显示保存成功。
   *
   *   与其要求调用方记得 useCallback，不如让这个组件自己扛住 ——
   *   靠调用方守纪律的约定，迟早有一处不守。
   */
  const clear = useRef(onError);
  useEffect(() => {
    clear.current = onError;
  }, [onError]);

  /**
   * ★ 卸载时清掉自己的错误。
   *   高级选项收起来、或者切到别的模式时这个框会消失，
   *   而它留下的那条错误会永远禁着保存按钮 —— 页面上还找不到是谁在报错。
   */
  useEffect(() => () => clear.current(errorKey, null), [errorKey]);

  const handle = (next: string) => {
    setText(next);

    if (next.trim() === '') {
      setProblem(null);
      onError(errorKey, null);
      onChange({});
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : '格式不正确';
      setProblem(message);
      onError(errorKey, message);
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      const message = '必须是 JSON 对象，形如 {"KEY": "值"}';
      setProblem(message);
      onError(errorKey, message);
      return;
    }

    setProblem(null);
    onError(errorKey, null);
    onChange(parsed as Record<string, unknown>);
  };

  return (
    <>
      <Textarea
        value={text}
        onChange={(e) => handle(e.target.value)}
        rows={rows}
        spellCheck={false}
        placeholder={'{\n  "ANTHROPIC_BASE_URL": "https://gw.example.com"\n}'}
        className={clsx('font-mono text-xs', problem && 'border-rose-300')}
      />
      {problem && <p className="mt-1 text-[11px] text-rose-600">{problem}</p>}
    </>
  );
}

function toJsonText(value: unknown): string {
  if (value === undefined || value === null) return '';
  /**
   * ★ 空表显示成空文本框，而不是一对光秃秃的 `{}`。
   *   空着才会显示 placeholder 里的示例 —— 对没填过的人来说，
   *   那行示例是这一栏唯一说明「该往里写什么」的东西。
   */
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
    return '';
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

/**
 * JSON 框旁边的说明书：平台认识哪些键、能填什么、默认是什么。
 *
 * ★★ 取消逐项表单之后，这张表是这一页信息量的全部来源。
 *   JSON 文本框里只有键名，没有取值范围、没有「这一项影响成本」、
 *   也没有各运行时「做不到什么」—— 那些正是用户在这一页要做的判断
 *   （哪个 Agent 干哪类活、调这个数字会不会烧钱）所依赖的东西。
 *   所以它不是可选的装饰，是从表单里搬过来的那部分内容。
 */
function ConfigReference({ fields }: { fields: ConfigField[] }) {
  return (
    <div className="mt-1 space-y-1 rounded border border-slate-200 bg-white p-2">
      {fields.map((f) => (
        <div key={f.key} className="text-[11px] leading-relaxed">
          <div className="flex flex-wrap items-center gap-1">
            <code className="rounded bg-slate-100 px-1 py-0.5 font-medium text-slate-800">
              {f.key}
            </code>
            <span className="text-slate-500">{f.label}</span>
            <span className="text-slate-400">· 默认 {formatValue(f.default)}</span>
            {f.impact === 'cost' && (
              <span className="rounded bg-amber-50 px-1 text-[10px] text-amber-800">影响成本</span>
            )}
            {f.impact === 'safety' && (
              <span className="rounded bg-rose-50 px-1 text-[10px] text-rose-700">影响安全边界</span>
            )}
          </div>
          {/* ★ 取值范围要写死在这里：JSON 框不会拦下越界的值，服务端才会 */}
          <p className="text-slate-500">{describeAccepts(f)}</p>
          {f.help && <p className="text-slate-500">{f.help}</p>}
          {(f.options ?? []).some((o) => o.help) && (
            <ul className="ml-3 list-disc text-slate-400">
              {(f.options ?? [])
                .filter((o) => o.help)
                .map((o) => (
                  <li key={o.value}>
                    <code>{o.value}</code> —— {o.help}
                  </li>
                ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

/** 这个键能填什么。写给对着一个空 JSON 框的人看 */
function describeAccepts(f: ConfigField): string {
  switch (f.type) {
    case 'select':
      return `只能是：${(f.options ?? []).map((o) => `"${o.value}"`).join(' / ')}`;
    case 'number': {
      const range =
        f.min !== undefined && f.max !== undefined
          ? `（${f.min} ~ ${f.max}）`
          : f.min !== undefined
            ? `（不小于 ${f.min}）`
            : f.max !== undefined
              ? `（不大于 ${f.max}）`
              : '';
      return `数字${range}`;
    }
    case 'boolean':
      return 'true / false';
    case 'string_list':
      return '字符串数组，如 ["--flag", "值"]';
    case 'json':
      return f.jsonShape === 'env'
        ? 'JSON 对象，键是环境变量名、值必须是字符串（数字要加引号）'
        : 'JSON 对象';
    default:
      return '字符串';
  }
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
  /**
   * ★ JSON 对象只列键名。
   *   值里可能有网关地址、也可能有 `secret://saved` 这种占位符 ——
   *   卡片上一个也不该出现：前者是噪音，后者会让人以为凭证存坏了。
   */
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>);
    return keys.length > 0 ? keys.join('、') : '（空）';
  }
  /** 空串要显示成「（空）」—— 「默认 」后面跟着一片空白看着像坏了 */
  if (v === '' || v === null || v === undefined) return '（空）';
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
        <Button variant="neutral" size="sm"
          onClick={() => setCreating(true)}
          className="ml-auto">
          + 登记仓库
        </Button>
      </div>

      {/* ★ git 环境问题在这一页说清楚，而不是等第一次派发才炸 */}
      {!data.gitAvailable && (
        <Notice tone="error">
          {data.gitProblem} —— 需要代码仓库的任务将无法派发。
        </Notice>
      )}
      {/* ★ 同理：少装 openssh-client 的话，ssh 形态的仓库一个都用不了 */}
      {!data.sshAvailable && data.repositories.some((r) => r.authKind === 'ssh_key') && (
        <Notice tone="error">{data.sshProblem}</Notice>
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
          encryptsInline={data.encryptsInlineSecrets}
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
          <Button variant="outline" size="xs"
            onClick={() => probe.mutate()}
            disabled={probe.isPending}>
            {probe.isPending ? '测试中…' : '测试连接'}
          </Button>
          <Button variant="outline" size="xs"
            onClick={onEdit}>
            编辑
          </Button>
          <Button variant="outline" size="xs"
            onClick={onDelete}
            className="text-rose-600 hover:bg-rose-50">
            删除
          </Button>
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
          ★ 两种认证形态各显示各的那一项。
            token 这边最容易错的是用户名占位（错了就是 401，而 401 的报错
            不指向它 —— 自建 GitLab 踩的就是这个坑）；ssh 这边最容易被忽略
            的是主机公钥有没有固定 —— 没固定的话 TOFU 等于没有校验。
        */}
        {repo.authKind === 'token' ? (
          <Field label="凭证用户名">
            <span className={repo.authUsernameSource === 'default' ? 'text-amber-700' : ''}>
              {repo.authUsername}
            </span>
            <span className="ml-1 text-slate-400">
              （{AUTH_SOURCE_LABEL[repo.authUsernameSource]}
              {repo.authProvider ? ` · ${repo.authProvider}` : ''}）
            </span>
          </Field>
        ) : (
          <Field label="主机公钥">
            {repo.sshHostKeyPinned ? (
              <span className="text-emerald-700">
                已固定{repo.sshHosts.length > 0 ? `（${repo.sshHosts.join('、')}）` : ''}
              </span>
            ) : (
              <span className="text-amber-700">未固定 · 首次连接学习</span>
            )}
          </Field>
        )}
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
  encryptsInline,
  onClose,
  onDone,
}: {
  projectId: string;
  /** 传了就是编辑，标识与远端不可改 */
  existing?: RepositoryRow | null;
  /** 直接粘贴的凭证是不是密文入库。两种都能存，只影响提示语 */
  encryptsInline: boolean;
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
    sshKnownHosts: existing?.sshKnownHosts ?? '',
    orgWide: existing ? existing.scope === 'organization' : false,
  });

  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  /**
   * ★ 两种认证形态的字段不重叠，同时摆出来只会让人填错栏 ——
   *   往 ssh 仓库里填 token、往 https 仓库里贴私钥都是真实发生过的错误。
   *   判据和服务端的 isHttpRemote 一致；这里只决定显示什么，
   *   真正生效的判定在服务端。
   */
  const isSsh = !/^https?:\/\//i.test((isEdit ? existing!.remoteUrl : form.remoteUrl).trim());

  const create = useMutation({
    mutationFn: () =>
      isEdit
        ? api.updateRepository(existing!.id, {
            name: form.name,
            defaultBranch: form.defaultBranch,
            branchPrefix: form.branchPrefix,
            authUsername: form.authUsername.trim() || null,
            checkCommand: form.checkCommand.trim() || null,
            // null = 清空（下次连接重新学习），这是服务器换了密钥时的出路
            sshKnownHosts: form.sshKnownHosts.trim() || null,
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
            sshKnownHosts: form.sshKnownHosts.trim() || null,
            credential: form.credential.trim() || null,
            projectId: form.orgWide ? null : projectId,
          }),
    onSuccess: onDone,
  });

  return (
    <Modal
      onClose={onClose}
      title="代码仓库配置"
      width="lg"
      footer={
        <div className="space-y-2">
          {create.error instanceof ApiError && (
            <p className="text-xs text-rose-600">{create.error.message}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button variant="neutral" size="sm"
              disabled={!form.ref.trim() || !form.remoteUrl.trim() || create.isPending}
              onClick={() => create.mutate()}>
              {create.isPending ? '登记中…' : '登记'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">
          {isEdit ? `编辑「${existing!.name}」` : '登记代码仓库'}
        </h2>
        <label className="block">
          <span className="text-xs font-medium text-slate-700">标识</span>
          <Input
            value={form.ref}
            disabled={isEdit}
            onChange={(e) => set('ref', e.target.value)}
            placeholder="order-service"
            className="mt-1 disabled:bg-slate-50 disabled:text-slate-500" />
          <p className="mt-1 text-[11px] text-slate-500">
            Agent 资源范围里填的就是这个值，登记后不建议再改。
          </p>
        </label>

        <label className="block">
          <span className="text-xs font-medium text-slate-700">显示名</span>
          <Input
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            className="mt-1" />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-slate-700">git 地址</span>
          <Input
            value={form.remoteUrl}
            disabled={isEdit}
            onChange={(e) => set('remoteUrl', e.target.value)}
            placeholder="https://github.com/acme/order-service.git"
            className="mt-1 disabled:bg-slate-50 disabled:text-slate-500" />
          <p className="mt-1 text-[11px] text-slate-500">
            https 用 token 认证，<code>git@…</code> / <code>ssh://…</code> 用 SSH 私钥 ——
            填完地址下面的凭证字段会跟着切换。
          </p>
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-xs font-medium text-slate-700">默认分支</span>
            <Input
              value={form.defaultBranch}
              onChange={(e) => set('defaultBranch', e.target.value)}
              className="mt-1" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-700">分支前缀</span>
            <Input
              value={form.branchPrefix}
              onChange={(e) => set('branchPrefix', e.target.value)}
              className="mt-1" />
          </label>
        </div>

        {!isSsh && (
          <label className="block">
            <span className="text-xs font-medium text-slate-700">
              凭证用户名占位
              <span className="ml-1 font-normal text-slate-400">选填</span>
            </span>
            <Input
              value={form.authUsername}
              onChange={(e) => set('authUsername', e.target.value)}
              placeholder={guessedAuthUsername(form.remoteUrl)}
              className="mt-1" />
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
        )}

        {isSsh && (
          <label className="block">
            <span className="text-xs font-medium text-slate-700">
              主机公钥
              <span className="ml-1 font-normal text-slate-400">选填 · known_hosts 格式</span>
            </span>
            <Textarea
              value={form.sshKnownHosts}
              onChange={(e) => set('sshKnownHosts', e.target.value)}
              rows={2}
              placeholder="github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA…"
              className="mt-1 font-mono"
            />
            {/*
              ★ 留空不等于不校验 —— 首次连接会 TOFU 学到并自动固定。
                但那一次窗口是真实存在的，所以要给出关掉它的办法。
              ★ 这一栏**不加密**，因为主机公钥本来就是公开比对的那一份。
                必须说清楚，否则会有人把私钥贴进来。
            */}
            <p className="mt-1 text-[11px] text-slate-500">
              用 <code>ssh-keyscan github.com</code> 生成。留空的话首次连接会自动学习并固定，
              此后转严格校验 —— 填在这里只是把首次那一次的信任窗口也关掉。
              <span className="text-amber-700">这是公开信息，不加密保存；私钥请填在下面一栏。</span>
            </p>
          </label>
        )}

        <label className="block">
          <span className="text-xs font-medium text-slate-700">
            质量核验命令
            <span className="ml-1 font-normal text-slate-400">选填</span>
          </span>
          <Input
            value={form.checkCommand}
            onChange={(e) => set('checkCommand', e.target.value)}
            placeholder="pnpm test"
            className="mt-1" />
          {/*
            ★ 不填不是「少个功能」，是 reviewing 阶段的门禁没有数据可依据。
          */}
          <p className="mt-1 text-[11px] text-slate-500">
            Agent 收工后、提交之前在工作区执行。不填的话，reviewing
            阶段的质量门禁只能依据 Agent 自述 —— 那是一句话，不是证据。
          </p>
        </label>

        <label className="block">
          <span className="text-xs font-medium text-slate-700">
            {isSsh ? 'SSH 私钥' : '访问凭证'}
          </span>
          {/*
            ★★ 私钥必须用 textarea：`<input>` 会把粘贴内容里的换行吃掉，
              而 PEM 是多行的 —— 单行输入框根本装不下一把 key，
              表现是保存后提示「格式不正确」，而用户明明整段复制了。
          */}
          {isSsh ? (
            <Textarea
              value={form.credential}
              onChange={(e) => set('credential', e.target.value)}
              rows={4}
              placeholder={
                '-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----\n\n或 env:变量名'
              }
              className="mt-1 font-mono"
            />
          ) : (
            <Input
              value={form.credential}
              onChange={(e) => set('credential', e.target.value)}
              type="password"
              placeholder="ghp_… 或 env:变量名"
              className="mt-1" />
          )}
          <p className="mt-1 text-[11px] text-slate-500">
            {isSsh ? (
              <>
                粘贴私钥全文（部署密钥即可，只需这个仓库的读写权限）。
                {encryptsInline ? '加密保存' : '明文保存（未配置 APOS_SECRET_KEY）'}，接口永不回显。
                <span className="text-amber-700">
                  不支持带密码短语的私钥 —— 无人值守场景没法输入，保存时会被拒。
                </span>
                {' '}留空则回退到宿主机的 <code>~/.ssh</code>，容器化部署里通常没有。
              </>
            ) : (
              '私有仓库必填，否则准备工作区时会克隆失败。'
            )}
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
        <Button variant="neutral" size="sm"
          onClick={() => setEditing('new')}
          className="ml-auto">
          + 新增约定
        </Button>
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
                  <Button variant="outline" size="xs"
                    onClick={() => toggle.mutate(c)}>
                    {c.enabled ? '停用' : '启用'}
                  </Button>
                  <Button variant="outline" size="xs"
                    onClick={() => setEditing(c)}>
                    编辑
                  </Button>
                  <Button variant="outline" size="xs"
                    onClick={() => remove.mutate(c.id)}
                    className="text-rose-600 hover:bg-rose-50">
                    删除
                  </Button>
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
    <Modal
      onClose={onClose}
      title="工程约定"
      width="lg"
      footer={
        <div className="space-y-2">
          {save.error instanceof ApiError && (
            <p className="text-xs text-rose-600">{save.error.message}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button variant="neutral" size="sm"
              disabled={!title.trim() || !content.trim() || save.isPending}
              onClick={() => save.mutate()}>
              {save.isPending ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">{row ? '编辑工程约定' : '新增工程约定'}</h2>
        <label className="block">
          <span className="text-xs font-medium text-slate-700">标题</span>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="如：提交规范"
            className="mt-1" />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-slate-700">内容</span>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            placeholder={'如：\n- 每个提交只做一件事\n- 新增逻辑必须带单元测试\n- 不要引入新依赖，先提出来讨论'}
            className="mt-1 font-mono"
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
