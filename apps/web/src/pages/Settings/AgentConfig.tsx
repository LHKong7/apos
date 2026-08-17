import { t, useT, useSpecText, type MessageKey } from '../../lib/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { relativeTime, tokens } from '../../lib/format';
import { CardSkeleton, EmptyState, ErrorState, QueryBoundary } from '../../components/states';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import { useAuthStore } from '../../stores/auth';
import type {
  AgentAdminRow,
  ConfigField,
  ConventionRow,
  CredentialUsageRow,
  RuntimeKindSpec,
} from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, Labeled, Notice, StatusDot } from './primitives';
import { AgentAccessPanel } from './AgentAccess';

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

type Tab = 'agents' | 'binding' | 'conventions';

/**
 * ★ 存词条键、不存译文：模块级常量取不到 hook，而且切语言时不会重算 ——
 *   在这里就把 `t()` 调完，标签会永远停在首次渲染时的那个语言。
 *   Keys, not translated strings: a module constant cannot call the hook and
 *   is not recomputed when the locale changes, so resolving here would freeze
 *   these labels in whichever language rendered first.
 */
const TABS: { key: Tab; labelKey: MessageKey; hintKey: MessageKey }[] = [
  { key: 'agents', labelKey: 'agentCfg.tab.agentsLabel', hintKey: 'agentCfg.tab.agents' },
  /**
   * ★ 与「Agent 配置」分成两页，不是一页两段。
   *
   *   上一页回答「这个 Agent 是什么」（运行时、凭证、模型、工具与资源权限），
   *   这一页回答「这个项目的哪个角色交给哪个已配置的 Agent」。
   *   混在一起正是之前的问题：用户在项目设置里被问「用哪个 CLI」，
   *   而那个选择的后果根本不在这一页上显示。
   */
  { key: 'binding', labelKey: 'agentCfg.tab.binding', hintKey: 'agentCfg.tab.bindingDesc' },
  /**
   * ★★ 「代码仓库」与「存储目标」都不在这一页了，它们合并成导航里的
   *   **工作区来源**（pages/Settings/WorkspaceSources.tsx）。
   *
   *   两者都不是某个 Agent 的属性，而是项目（或组织）级的资源登记 ——
   *   一个 monorepo 被五个 Agent 引用、一个 bucket 被三个 Agent 引用都是常态。
   *   挂在这一页底下既说错了归属，也让它找不到：想登记一个仓库或挂一个
   *   数据目录的人，脑子里没有 Agent。
   *
   *   留在这里的三格才真是 Agent 的属性：它是什么、项目里谁扮演什么角色、
   *   干活时守哪些工程约定。
   */
  { key: 'conventions', labelKey: 'agentCfg.tab.conventions', hintKey: 'agentCfg.tab.conventionsDesc' },
];

export function AgentConfigPage() {
  const t = useT();
  const { projectId } = useParams<{ projectId: string }>();
  const [tab, setTab] = useState<Tab>('agents');
  const userId = useAuthStore((s) => s.userId);

  if (!projectId || !userId) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">{t('agentCfg.title')}</h1>
          <Link to={`/projects/${projectId}`} className="text-xs text-slate-500 hover:text-slate-700">
            {t('agents.backToOverview')}
          </Link>
        </div>
        <div className="mt-2 flex gap-1">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              title={t(item.hintKey)}
              className={clsx(
                'rounded px-3 py-1 text-xs font-medium',
                tab === item.key
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100',
              )}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {tab === 'agents' && <AgentsSection />}
        {tab === 'binding' && <ProjectAgentSection projectId={projectId} />}
        {tab === 'conventions' && <ConventionsSection projectId={projectId} />}
      </div>
    </div>
  );
}

// ── Agents ────────────────────────────────────────────────────────────

function AgentsSection() {
  const t = useT();
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
  /**
   * ★★ 「删除请求成功了，但那个 Agent 还在」。
   *
   *   有历史执行记录、被需求指定为 PRD 编写者、还被项目角色绑着的 Agent
   *   一律转为停用（后端 deleteAgent）—— 这是对的，但不说出来的话，用户看到的
   *   只是「点了删除，它还在列表里」，也就是「删除按钮坏了」。
   *   服务端返回的 reason 说清了是被什么牵连、下一步该去哪儿，必须显示出来。
   */
  const [retired, setRetired] = useState<{ name: string; reason: string } | null>(null);

  const q = useQuery({ queryKey: qk.adminAgents(), queryFn: api.adminAgents });
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.adminAgents() });
  const openForm = (target: AgentAdminRow | 'new') => {
    setUnknownKeys([]);
    setEditing(target);
  };

  const probe = useMutation({ mutationFn: (id: string) => api.probeAgent(id), onSuccess: invalidate });
  const remove = useMutation({
    mutationFn: (agent: AgentAdminRow) =>
      api.deleteAgent(agent.id).then((res) => ({ ...res, name: agent.name })),
    /** 上一次删除留下的提示不能跟着这一次走 —— 它说的是另一个 Agent */
    onMutate: () => setRetired(null),
    onSuccess: (res) => {
      setRetired(res.retired && res.reason ? { name: res.name, reason: res.reason } : null);
      void invalidate();
    },
  });

  if (q.isLoading) return <CardSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data!;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-xs text-slate-500">
          {t('agentCfg.intro')}
        </p>
        <Button variant="neutral" size="sm"
          onClick={() => openForm('new')}
          className="ml-auto">
          + {t('agentCfg.new')}
        </Button>
      </div>

      {/*
        ★ 这里说的是「存成什么样」，不是「能不能存」。
          没配主密钥照样能保存 —— 只是明文进库，值得知道，但不该拦着人干活。
      */}
      {!data.encryptsInlineSecrets && (
        <Notice tone="warning">
          {t('agentCfg.noMasterKey')} <strong>{t('agentCfg.plaintext')}</strong>{' '}
          {t('agentCfg.noMasterKey2')}{' '}
          {t('agentCfg.noMasterKey3', { ref: t('agentCfg.envRef') })}
        </Notice>
      )}

      {unknownKeys.length > 0 && (
        <Notice tone="warning">
          {t('agentCfg.unknownKeysNotice', { keys: unknownKeys.join('、') })}
        </Notice>
      )}

      {retired && (
        <Notice tone="warning">
          {t('agentCfg.retiredNotice', { name: retired.name, reason: retired.reason })}
        </Notice>
      )}

      {data.credentialUsage.length > 0 && <CredentialUsage rows={data.credentialUsage} />}

      {data.agents.length === 0 ? (
        <EmptyState
          icon="🤖"
          message={t('agentCfg.empty')}
          hint={t('agentCfg.emptyHint')}
          action={{ label: t('agentCfg.new'), onClick: () => openForm('new') }}
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
              onDelete={() => remove.mutate(a)}
              /** 报错只挂在被删的那张卡上：挂在所有卡上会看成「全都删不掉」 */
              error={remove.variables?.id === a.id ? remove.error : null}
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
  const t = useT();
  const multi = rows.filter((r) => r.rotationCost !== 'one_place' && r.agents.length > 1);

  return (
    <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
      <p className="text-[11px] font-medium text-slate-700">{t('agentCfg.credentialUsage')}</p>
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
                ? t('agentCfg.rotateHint')
                : t('agentCfg.rotateCount', { count: r.agents.length })}
            </span>
          </div>
        ))}
      </div>
      {multi.length > 0 && (
        <p className="mt-1 text-[11px] text-amber-800">
          {t('agentCfg.inlineCredWarning')}{' '}
          {t('agentCfg.shareViaEnv', { ref: t('agentCfg.envRef') })}
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
  const t = useT();
  const sx = useSpecText();
  const [showCaps, setShowCaps] = useState(false);

  /**
   * ★ 三种「不可用」分开显示。
   *   混成一句「不可用」，用户不知道该去装依赖、换 key，还是换个 Agent。
   */
  const health = !agent.registered
    ? { tone: 'error' as const, text: agent.problem ?? t('agentCfg.health.unregistered') }
    : !agent.credentialUsable && agent.credentialHint
      ? { tone: 'error' as const, text: agent.credentialProblem ?? t('agentCfg.health.badCredential') }
      : /*
         * ★ 环境变量表里解不开的引用与凭证不可用是同一类问题：
         *   配置看着完好，派发时才炸，而报错不会指向那个没设置的变量。
         */
        agent.runtimeConfigProblems.length > 0
        ? { tone: 'error' as const, text: agent.runtimeConfigProblems[0]! }
        : !agent.reachable
          ? { tone: 'warning' as const, text: agent.problem ?? t('agentCfg.health.probeFailed') }
          : { tone: 'ok' as const, text: t('agentCfg.health.ready') };

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
            {agent.status === 'paused' ? t('agentCfg.status.paused') : t('agentCfg.status.retired')}
          </span>
        )}
        {agent.capability?.restricted && (
          <span
            className="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] text-rose-700"
            title={t('agentCfg.restrictedTitle')}
          >
            {t('agentCfg.notForHighRisk')}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="xs"
            onClick={onProbe}
            disabled={probing}>
            {probing ? t('agentCfg.probing') : t('agentCfg.probe')}
          </Button>
          <Button variant="outline" size="xs"
            onClick={onEdit}>
            {t('common.edit')}
          </Button>
          <Button variant="outline" size="xs"
            onClick={onDelete}
            className="text-rose-600 hover:bg-rose-50">
            {t('common.delete')}
          </Button>
        </div>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-600 sm:grid-cols-4">
        <Field label={t('agentCfg.field.credential')}>
          {agent.credentialHint ? (
            <span className={agent.credentialUsable ? '' : 'text-rose-600'}>
              {agent.credentialHint}
            </span>
          ) : (
            <span className="text-slate-400">{t('agentCfg.notConfigured')}</span>
          )}
        </Field>
        {/*
          ★ 空的时候要**显眼地**说出来，而不是显示一个「—」。
            这个 Agent 会一直闲着，而它的凭证、探针、权限全是绿的 ——
            不在卡片上点破的话，排查会从运行时一路查到调度器。
        */}
        <Field label={t('agent.scope.field')}>
          {agent.applicableTypes.length > 0 ? (
            agent.applicableTypes.map((t) => typeLabel(t)).join('、')
          ) : (
            <span className="text-amber-700">{t('agent.scope.unset')}</span>
          )}
        </Field>
        <Field label={t('agentCfg.field.concurrency')}>
          {t('agentCfg.concurrencyValue', {
            n: agent.maxConcurrency,
            minutes: Math.round(agent.timeoutSeconds / 60),
          })}
        </Field>
        <Field label={t('agentCfg.field.tokenLimit')}>
          {agent.tokenLimitPerRun === null ? '—' : tokens(agent.tokenLimitPerRun)}
        </Field>
        <Field label={t('agentCfg.field.lastProbe')}>{agent.lastCheckAt ? relativeTime(agent.lastCheckAt) : '—'}</Field>
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
              title={sx(f.help ?? '', f.helpEn)}
            >
              {sx(f.label, f.labelEn)}: {formatValue(agent.runtimeConfig[f.key])}
            </span>
          ))}
          {customKeys.map((k) => (
            <span
              key={k}
              className="rounded border border-dashed border-slate-300 px-1.5 py-0.5 font-mono text-[11px] text-slate-600"
              title={t('agentCfg.unknownKeys')}
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
            {showCaps ? t('agentCfg.collapseCapabilities') : t('agentCfg.capabilityList', { count: agent.capability.missing.length })}
          </button>
          {showCaps && (
            <div className="mt-2 space-y-1">
              {/*
                ★ 不静默降级：缺什么能力、会有什么影响，全部摊开。
                  用户在派高风险任务之前有权知道「这个 Agent 的暂停其实是终止」。
              */}
              {agent.capability.missing.length === 0 ? (
                <p className="text-[11px] text-emerald-700">{t('agentCfg.capabilitiesComplete')}</p>
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
                    <span className="font-medium">{m.feature}</span> · {sx(m.behavior, m.behaviorEn)}
                    <span className="block text-slate-500">
                        {t('agentCfg.userImpact', { impact: sx(m.userImpact, m.userImpactEn) })}
                      </span>
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
  const t = useT();
  const sx = useSpecText();
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
  /**
   * ★★ 组织级配置的是**上限**，不是「它能做什么」。
   *
   *   实际授权在项目里选档案（见 AgentAccess.tsx）。这一页只回答
   *   「这个 Agent 最多能被授权到什么程度」—— 项目管理员在自己项目里
   *   选不出组织没打算给它的能力。
   *
   * ★ `null` = 不设上限，和「一条都不给」相反。界面上用一个开关表达，
   *   而不是让空清单去兼任两种含义。
   */
  const [limited, setLimited] = useState(agent?.ceiling.capabilityCeiling !== null);
  const [ceiling, setCeiling] = useState<string[]>(
    agent?.ceiling.capabilityCeiling ?? [...DEFAULT_CEILING],
  );
  const [deniedCapabilities, setDeniedCapabilities] = useState<string[]>(
    agent?.ceiling.deniedCapabilities ?? [],
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
        // ★ 不设上限时送 null，不是空数组 —— 两者含义相反
        capabilityCeiling: limited ? ceiling : null,
        deniedCapabilities,
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
      title={t('agentCfg.title')}
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
          {jsonProblem && (
            <p className="text-xs text-rose-600">
              {t('agentCfg.jsonNotFixed', { problem: jsonProblem })}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="neutral" size="sm"
              disabled={!name.trim() || !ownerId || save.isPending || jsonProblem !== null}
              onClick={() => save.mutate()}>
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">
          {agent ? t('agentCfg.editing', { name: agent.name }) : t('agentCfg.new')}
        </h2>

        <div className="grid grid-cols-2 gap-2">
          <Labeled label={t('agentCfg.form.name')}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('agentCfg.form.namePlaceholder')} />
          </Labeled>
          <Labeled label={t('agentCfg.form.type')}>
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

        <Labeled
          label={t('agentCfg.form.description')}
          help={t('agentCfg.form.descriptionHelp')}
        >
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder={t('agentCfg.form.descriptionPlaceholder')}
          />
        </Labeled>

        {/* ── 运行时 ── */}
        <div className="rounded border border-slate-200 bg-slate-50 p-2">
          <p className="mb-2 text-[11px] font-medium text-slate-700">
            {t('agentCfg.form.runtime')}
          </p>

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
            {spec && (
              <p className="mt-1 text-[11px] text-slate-500">
                {sx(spec.description, spec.descriptionEn)}
              </p>
            )}
            {spec?.prerequisite && (
              <p className="mt-1 text-[11px] text-amber-800">
                ⚠ {sx(spec.prerequisite, spec.prerequisiteEn)}
              </p>
            )}
          </Labeled>

          {spec?.credential && (
            <Labeled
              label={sx(spec.credential.label, spec.credential.labelEn)}
              help={credentialHelp}
            >
              <Input
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                type="password"
                placeholder={
                  agent?.credentialHint
                    ? t('agentCfg.form.credentialCurrent', { hint: agent.credentialHint })
                    : t('agentCfg.form.credentialPlaceholder')
                } />
            </Labeled>
          )}

          {spec?.endpoint && (
            <Labeled
              label={sx(spec.endpoint.label, spec.endpoint.labelEn)}
              help={sx(spec.endpoint.help, spec.endpoint.helpEn)}
            >
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
            label={t('agentCfg.form.runtimeConfig')}
            help={
              t('agentCfg.form.runtimeConfigHelp') +
              t('agentCfg.form.secretKeys') +
              (encryptsInline ? t('agentCfg.form.encrypted') : t('agentCfg.form.plaintextStored')) +
              t('agentCfg.secretEcho')
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
                {showReference
                  ? t('agentCfg.form.collapseOptions')
                  : t('agentCfg.form.optionsCount', { count: spec.fields.length })}
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
          <p className="mb-1 text-[11px] font-medium text-slate-700">{t('agent.scope.heading')}</p>
          <p className="mb-2 text-[11px] text-slate-500">
            {t('agent.scope.help')}
            {/*
              ★ 「一个都不勾」的后果要当场说，不能等用户发现 Agent 一直闲着。
                这是这一栏被漏掉时最贵的那个症状：配置看起来是完整的。
            */}
            <span className={clsx(applicableTypes.length === 0 && 'text-amber-700')}>
              {t('agent.scope.emptyWarning')}
            </span>
            {t('agent.scope.requirementNote')}
          </p>
          <div className="flex flex-wrap gap-1">
            {WORK_ITEM_TYPES.map(([value, labelKey]) => {
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
                  {t(labelKey)}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── 权限 ── */}
        <div className="rounded border border-slate-200 bg-slate-50 p-2">
          <p className="mb-2 text-[11px] font-medium text-slate-700">
            {t('agentCfg.form.permissions')}
          </p>
          {/*
            ★★ 这里曾经是三个字段：allowedTools、deniedTools、resourceScopes。
              前两个要求用户先懂某个 CLI 的工具名，第三个把组织级配置
              当成了项目级授权用。现在：上限在这一页，实际授权在项目里
              选档案（项目设置 → 项目 Agent → 生效权限）。
          */}
          <label className="flex items-start gap-2 text-xs">
            <Checkbox
              checked={limited}
              onCheckedChange={(v) => setLimited(Boolean(v))}
              className="mt-0.5"
            />
            <span>
              {t('agentCfg.form.limitCeiling')}
              <span className="ml-1 text-[11px] text-slate-400">
                {t('agentCfg.form.limitCeilingHint')}
              </span>
            </span>
          </label>

          {limited && (
            <Labeled label={t('agentCfg.form.ceiling')} help={t('agentCfg.form.ceilingHelp')}>
              <CapabilityPicker value={ceiling} onChange={setCeiling} />
            </Labeled>
          )}

          <Labeled
            label={t('agentCfg.form.hardDenied')}
            help={t('agentCfg.form.hardDeniedHelp')}
          >
            <CapabilityPicker value={deniedCapabilities} onChange={setDeniedCapabilities} />
          </Labeled>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Labeled label={t('agentCfg.form.owner')} help={t('agentCfg.form.ownerHelp')}>
            <select
              value={ownerId}
              onChange={(e) => setOwnerId(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">{t('agentCfg.form.choose')}</option>
              {(users.data?.users ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label={t('agentCfg.form.skills')} help={t('agentCfg.form.skillsHelp')}>
            <Input
              value={skills}
              onChange={(e) => setSkills(e.target.value)}
              placeholder={t('agentCfg.form.skillsPlaceholder')} />
          </Labeled>
        </div>

        {agent && (
          <Labeled label={t('agentCfg.form.reason')} help={t('agentCfg.form.reasonHelp')}>
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
const WORK_ITEM_TYPES: [string, MessageKey][] = [
  ['requirement', 'workItemType.requirement'],
  ['feature', 'workItemType.feature'],
  ['story', 'workItemType.story'],
  ['task', 'workItemType.task'],
  ['bug', 'workItemType.bug'],
  ['research', 'workItemType.research'],
  ['review', 'workItemType.review'],
  ['test', 'workItemType.test'],
  ['incident', 'workItemType.incident'],
  ['decision', 'workItemType.decision'],
  ['approval', 'workItemType.approval'],
  ['release', 'workItemType.release'],
  ['knowledge', 'workItemType.knowledge'],
];

/** 认不出来的类型原样显示 —— 库里出现新类型时，显示成空白比显示英文更糟 */
function typeLabel(value: string): string {
  // ★ 这个函数不是组件，用模块级 t（取当前语言、不订阅）
  const key = WORK_ITEM_TYPES.find(([v]) => v === value)?.[1];
  return key ? t(key) : value;
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
  const t = useT();
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
      const message = err instanceof Error ? err.message : t('agentCfg.json.invalid');
      setProblem(message);
      onError(errorKey, message);
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      const message = t('agentCfg.json.mustBeObject');
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
  const t = useT();
  const sx = useSpecText();
  return (
    <div className="mt-1 space-y-1 rounded border border-slate-200 bg-white p-2">
      {fields.map((f) => (
        <div key={f.key} className="text-[11px] leading-relaxed">
          <div className="flex flex-wrap items-center gap-1">
            <code className="rounded bg-slate-100 px-1 py-0.5 font-medium text-slate-800">
              {f.key}
            </code>
            <span className="text-slate-500">{sx(f.label, f.labelEn)}</span>
            <span className="text-slate-400">
              {t('agentCfg.defaultValue', { value: formatValue(f.default) })}
            </span>
            {f.impact === 'cost' && (
              <span className="rounded bg-amber-50 px-1 text-[10px] text-amber-800">{t('agentCfg.impact.cost')}</span>
            )}
            {f.impact === 'safety' && (
              <span className="rounded bg-rose-50 px-1 text-[10px] text-rose-700">{t('agentCfg.impact.safety')}</span>
            )}
          </div>
          {/* ★ 取值范围要写死在这里：JSON 框不会拦下越界的值，服务端才会 */}
          <p className="text-slate-500">{describeAccepts(f)}</p>
          {f.help && <p className="text-slate-500">{sx(f.help, f.helpEn)}</p>}
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

/**
 * 这个键能填什么。写给对着一个空 JSON 框的人看。
 * What this key accepts — written for someone staring at an empty JSON box.
 */
function describeAccepts(f: ConfigField): string {
  switch (f.type) {
    case 'select':
      return t('agentCfg.accepts.oneOf', {
        options: (f.options ?? []).map((o) => `"${o.value}"`).join(' / '),
      });
    case 'number': {
      const range =
        f.min !== undefined && f.max !== undefined
          ? t('agentCfg.accepts.range', { min: f.min, max: f.max })
          : f.min !== undefined
            ? t('agentCfg.accepts.min', { min: f.min })
            : f.max !== undefined
              ? t('agentCfg.accepts.max', { max: f.max })
              : '';
      return t('agentCfg.accepts.number', { range });
    }
    case 'boolean':
      return 'true / false';
    case 'string_list':
      return t('agentCfg.accepts.stringList');
    case 'json':
      return f.jsonShape === 'env'
        ? t('agentCfg.accepts.envObject')
        : t('agentCfg.accepts.jsonObject');
    default:
      return t('agentCfg.accepts.string');
  }
}

function splitList(v: string): string[] {
  return v
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatValue(v: unknown): string {
  if (Array.isArray(v)) return v.join('、') || t('agentCfg.emptyValue');
  /**
   * ★ JSON 对象只列键名。
   *   值里可能有网关地址、也可能有 `secret://saved` 这种占位符 ——
   *   卡片上一个也不该出现：前者是噪音，后者会让人以为凭证存坏了。
   */
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>);
    return keys.length > 0 ? keys.join('、') : t('agentCfg.emptyValue');
  }
  /** 空串要显示成「（空）」—— 「默认 」后面跟着一片空白看着像坏了 */
  if (v === '' || v === null || v === undefined) return t('agentCfg.emptyValue');
  return String(v);
}


// ── 代码仓库 ──────────────────────────────────────────────────────────

// ── 工程约定 ──────────────────────────────────────────────────────────

function ConventionsSection({ projectId }: { projectId: string }) {
  const t = useT();
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
        <p className="text-xs text-slate-500">{t('agentCfg.conv.intro')}</p>
        <Button variant="neutral" size="sm"
          onClick={() => setEditing('new')}
          className="ml-auto">
          {t('agentCfg.convention.add')}
        </Button>
      </div>

      {data.conventions.length === 0 ? (
        <EmptyState
          icon="📐"
          message={t('agentCfg.conv.empty')}
          hint={t('agentCfg.conv.emptyHint')}
          action={{ label: t('agentCfg.conv.new'), onClick: () => setEditing('new') }}
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
                  {c.priority === 'must_read' ? t('agentCfg.conv.mustRead') : t('agentCfg.conv.reference')}
                </span>
                {c.appliesTo.length > 0 && (
                  <span className="text-[11px] text-slate-500">
                    {t('agentCfg.convention.appliesTo', { types: c.appliesTo.join('、') })}
                  </span>
                )}
                <div className="ml-auto flex gap-1">
                  <Button variant="outline" size="xs"
                    onClick={() => toggle.mutate(c)}>
                    {c.enabled ? t('agentCfg.conv.disable') : t('agentCfg.conv.enable')}
                  </Button>
                  <Button variant="outline" size="xs"
                    onClick={() => setEditing(c)}>
                    {t('common.edit')}
                  </Button>
                  <Button variant="outline" size="xs"
                    onClick={() => remove.mutate(c.id)}
                    className="text-rose-600 hover:bg-rose-50">
                    {t('common.delete')}
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
  const t = useT();
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
      title={t('agentCfg.conv.title')}
      width="lg"
      footer={
        <div className="space-y-2">
          {save.error instanceof ApiError && (
            <p className="text-xs text-rose-600">{save.error.message}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="neutral" size="sm"
              disabled={!title.trim() || !content.trim() || save.isPending}
              onClick={() => save.mutate()}>
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">{row ? t('agentCfg.conv.edit') : t('agentCfg.conv.add')}</h2>
        <label className="block">
          <span className="text-xs font-medium text-slate-700">{t('agentCfg.conv.titleField')}</span>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('agentCfg.conv.titlePlaceholder')}
            className="mt-1" />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-slate-700">{t('agentCfg.conv.content')}</span>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            placeholder={t('agentCfg.conv.contentPlaceholder')}
            className="mt-1 font-mono"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-slate-700">{t('agentCfg.conv.priority')}</span>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="must_read">{t('agentCfg.conv.mustReadOption')}</option>
            <option value="reference">{t('agentCfg.conv.referenceOption')}</option>
          </select>
        </label>
      </div>
    </Modal>
  );
}

/** 项目 Agent 角色绑定 —— planner / coordinator / reviewer 各交给哪个已配置的 Agent */
const BINDING_ROLES: { role: string; labelKey: MessageKey; hintKey: MessageKey }[] = [
  { role: 'planner', labelKey: 'binding.planner', hintKey: 'binding.plannerHint' },
  { role: 'coordinator', labelKey: 'binding.coordinator', hintKey: 'binding.coordinatorHint' },
  { role: 'reviewer', labelKey: 'binding.reviewer', hintKey: 'binding.reviewerHint' },
];

/**
 * 项目 Agent 绑定。
 *
 * ★★ 在这一页出现之前，「Project Agent」是现算的：从组织里找第一个
 *   status=active 且适用类型含 requirement 的 Agent，按创建时间取第一个。
 *   用户指定不了，想换只能去改另一个 Agent 的配置或建号顺序 ——
 *   而这个 Agent 决定了此后所有需求分析与计划的产出。
 *
 * ★ 可选项只列**本项目成员**里的 Agent。列全组织的话，用户会选到一个
 *   保存时才被拒的 Agent，而那条报错出现在提交之后、不在选择的时候。
 */
function ProjectAgentSection({ projectId }: { projectId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: qk.projectAgents(projectId),
    queryFn: () => api.projectAgents(projectId),
  });

  const save = useMutation({
    mutationFn: (body: { role: string; agentId: string | null; priority?: number }) =>
      api.setProjectAgent(projectId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.projectAgents(projectId) });
    },
  });

  return (
    <QueryBoundary query={q}>
      {(data) => (
        <div className="space-y-3">
          <p className="text-xs text-slate-500">{t('binding.intro')}</p>

          {data.available.length === 0 && (
            <Notice tone="warning">{t('binding.noMembers')}</Notice>
          )}

          <div className="space-y-2">
            {BINDING_ROLES.map(({ role, labelKey, hintKey }) => {
              const bound = data.bindings.find((b) => b.role === role && b.priority === 0);
              const fallback = data.bindings.find((b) => b.role === role && b.priority === 1);
              return (
                <div key={role} className="rounded border border-slate-200 bg-white px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-slate-800">{t(labelKey)}</span>
                    {bound && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                        {bound.runtimeKind}
                      </span>
                    )}
                    <select
                      value={bound?.agentId ?? ''}
                      disabled={save.isPending}
                      onChange={(e) =>
                        save.mutate({ role, agentId: e.target.value || null, priority: 0 })
                      }
                      className="ml-auto w-56 rounded border border-slate-300 px-1.5 py-1 text-xs"
                      aria-label={t(labelKey)}
                    >
                      {/* ★ 解绑不是「没配」，是显式回到「按项目成员自动挑」 */}
                      <option value="">{t('binding.unbound')}</option>
                      {data.available.map((a) => (
                        <option key={a.agentId} value={a.agentId}>
                          {a.name} · {a.runtimeKind}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/*
                    ★★ 备选只在主 Agent 已经绑了之后才出现。
                      没有主的时候先问备选是本末倒置 —— 而且那时「退到备选」
                      根本无从谈起。
                  */}
                  {bound && (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] text-slate-500">{t('binding.fallback')}</span>
                      <select
                        value={fallback?.agentId ?? ''}
                        disabled={save.isPending}
                        onChange={(e) =>
                          save.mutate({ role, agentId: e.target.value || null, priority: 1 })
                        }
                        className="ml-auto w-56 rounded border border-slate-300 px-1.5 py-1 text-xs"
                        aria-label={t('binding.fallback')}
                      >
                        <option value="">{t('binding.noFallback')}</option>
                        {data.available
                          // ★ 主 Agent 不能同时当自己的备选
                          .filter((a) => a.agentId !== bound.agentId)
                          .map((a) => (
                            <option key={a.agentId} value={a.agentId}>
                              {a.name} · {a.runtimeKind}
                            </option>
                          ))}
                      </select>
                    </div>
                  )}

                  <p className="mt-0.5 text-[11px] text-slate-400">{t(hintKey)}</p>
                  {/*
                    ★ 这里曾经对 planner 提示「适用类型里没有 requirement，做不了规划」。
                      那条判据已经取消 —— 它管的是派工作项时的执行者匹配，
                      而规划与 PRD 编写不派工作项（见 http/project-agents.ts）。
                      留着这行黄字会指着一个其实跑得动的绑定说它跑不动。
                  */}
                </div>
              );
            })}
          </div>

          {save.error instanceof ApiError && (
            <p className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">
              {save.error.message}
            </p>
          )}

          {/*
            ★★ 绑定回答「谁干这个角色」，权限回答「它被授权做什么」——
              两个问题，同一页上下相邻。
              合成一格的话，「换一个规划 Agent」会顺手改到权限，
              而那是两个不同的决定，需要的权限也不同。
          */}
          {data.available.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold text-slate-800">{t('access.title')}</h2>
              {data.available.map((a) => (
                <AgentAccessPanel key={a.agentId} projectId={projectId} agentId={a.agentId} />
              ))}
            </div>
          )}
        </div>
      )}
    </QueryBoundary>
  );
}

/**
 * 能力上限的默认勾选。
 *
 * ★ 与平台默认档案（standard_executor）对齐：新建一个 Agent 时，
 *   上限刚好覆盖「在隔离工作区里干活」那一档。给一份能直接用的默认，
 *   而不是让用户对着一张空清单猜该勾什么 —— 猜出来的配置一律偏宽。
 */
const DEFAULT_CEILING = [
  'workspace.read',
  'workspace.write',
  'command.build',
  'command.test',
  'artifact.create',
] as const;

/**
 * 能力多选。
 *
 * ★★ 显示的是**后果**，不是能力名。`repository.push` 对用户没有意义，
 *   「能把分支推到远端。改动从此离开平台的控制范围」才有 ——
 *   而这正是这一勾与下一勾之间风险差两个数量级的地方。
 *
 * ★ 目录来自服务端（`/admin/agents` 的 capabilities），不在前端再抄一份：
 *   抄一份的代价是平台加了一条能力而界面上没有，用户没有任何迹象。
 */
function CapabilityPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const t = useT();
  const sx = useSpecText();
  const catalog = useQuery({ queryKey: qk.capabilityCatalog(), queryFn: api.capabilityCatalog });

  if (catalog.isLoading) return <CardSkeleton />;
  const items = catalog.data?.capabilities ?? [];

  const toggle = (key: string) =>
    onChange(value.includes(key) ? value.filter((v) => v !== key) : [...value, key]);

  return (
    <div className="space-y-1">
      {items.map((c) => (
        <label key={c.key} className="flex items-start gap-1.5 text-[11px]">
          <input
            type="checkbox"
            checked={value.includes(c.key)}
            onChange={() => toggle(c.key)}
            /**
             * ★ 平台底线里的能力永远勾不上（改权限、改 Policy）。
             *   给一个能勾但存不进去的选项，等于让人白填一遍再被拒。
             */
            disabled={c.neverAutoGrant}
            className="mt-0.5"
          />
          <span className={clsx(c.neverAutoGrant && 'text-slate-400')}>
            <span className="font-medium text-slate-700">{sx(c.label, c.labelEn)}</span>
            <span className="ml-1 text-slate-500">{sx(c.consequence, c.consequenceEn)}</span>
            {c.neverAutoGrant && (
              <span className="ml-1 text-amber-700">{t('agentCfg.form.neverGrant')}</span>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}
