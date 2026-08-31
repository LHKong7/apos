import { hasMessage, t, useT, useSpecText, type MessageKey } from '../../lib/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { relativeTime, tokens, joinList } from '../../lib/format';
import { CardSkeleton, EmptyState, ErrorState, QueryBoundary } from '../../components/states';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import { useAuthStore } from '../../stores/auth';
import type {
  AgentAdminRow,
  ConfigField,
  ConventionRow,
  CredentialProblemFields,
  CredentialUsageRow,
  RuntimeKindSpec,
} from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SELECT_EMPTY,
  toSelectValue,
  fromSelectValue,
} from '@/components/ui/select';
import { Field, Labeled, Notice, StatusDot } from './primitives';
import { AgentAccessPanel } from './AgentAccess';
import { confirmClose, useUnsavedGuard } from '../../lib/useUnsavedGuard';
import { RuntimeConfigForm } from './RuntimeConfigForm';

/**
 * Agent configuration (page doc 08 §5.5) / Agent 配置。
 *
 * ★ An agent is a first-class object and its runtime is one of its properties —
 *   there is no separate "connection" layer. Creating N agents means N independent
 *   configurations: CLI kind, that CLI's parameters, credential, permissions, and cost
 *   ceiling are all filled in on one form, with no detour to create a connection
 *   elsewhere and come back to attach it.
 *
 * ★★ The runtime configuration is a **free-form JSON box**, not a pile of
 *   field-by-field inputs.
 *
 *   The trouble with a per-field form is not that it is awkward, it is that it decides
 *   what can be configured at all: the platform's field list always lags the CLI
 *   itself, and during those weeks of lag, "no such box in the UI" means "this feature
 *   does not exist". Pointing at a relay, or adding a flag that shipped last week,
 *   should not have to wait for a platform release.
 *
 *   Keys the platform knows are still validated server-side (a bad value is refused on
 *   the spot); keys it does not know are stored verbatim and reported after saving —
 *   such a key may be deliberate, or it may be a typo.
 *
 * ★ What each CLI accepts is defined by the **platform** (RUNTIME_KIND_SPECS in
 *   contracts), and rendered here as a **reference sheet** next to the JSON box: which
 *   keys exist, their ranges, their defaults, and which ones affect cost or safety. The
 *   JSON box has no labels, so without that sheet the user is guessing key names.
 *
 * ★ The credential input appears only when **creating or rotating**, and never echoes
 *   the stored value back — in a system where a token can be read off the screen,
 *   sooner or later someone screenshots it.
 *
 * ★★ 运行时配置是一个自定义 JSON 文本框，不是逐项渲染的输入框：平台的字段表一定
 *   滞后于 CLI 本身，而滞后的那几周里「界面上没有那一栏」等于「这个功能不存在」。
 *   平台认识的键仍在服务端校验，不认识的键原样保存并在保存后提示。凭证只在新建或
 *   轮换时出现，且永远不回显。
 */

type Tab = 'agents' | 'binding' | 'conventions';

/**
 * ★ Keys, not translated strings: a module-level constant cannot call the hook and is
 *   not recomputed when the locale changes, so resolving `t()` here would freeze these
 *   labels in whichever language happened to render first.
 *
 * ★ 存词条键、不存译文：模块级常量取不到 hook，切语言时也不会重算。
 */
/**
 * How the agent health line is worded / Agent 健康度那一行的说法。
 *
 * ★★ The server hands over a triple — code, params, and a Chinese sentence — and the
 *   UI must render from the code. This line says "why this agent cannot be dispatched",
 *   one of the most important sentences in the whole product, and it used to appear in
 *   Chinese even in the English UI. The Chinese sentence stays as the fallback for a
 *   code the catalog does not recognize.
 */
function runtimeProblemText(agent: {
  problem: string | null;
  problemCode: 'probe_failed' | 'no_adapter' | null;
  problemParams?: Record<string, string | number>;
}): string {
  const key = `agentCfg.problem.${agent.problemCode}` as MessageKey;
  if (agent.problemCode && hasMessage(key)) return t(key, agent.problemParams ?? {});
  return agent.problem ?? t('agentCfg.health.unregistered');
}

function credentialProblemText(agent: CredentialProblemFields): string {
  const key = `credential.problem.${agent.credentialProblemCode}` as MessageKey;
  if (agent.credentialProblemCode && hasMessage(key)) {
    return t(key, agent.credentialProblemParams ?? {});
  }
  return agent.credentialProblem ?? t('agentCfg.health.badCredential');
}

/**
 * ★ The sentence "environment variable X: <reason>" is assembled by the UI, not by the
 *   server — when two layers of Chinese nest inside each other, both layers leak into
 *   the English interface.
 */
function envProblemText(p: {
  key: string;
  problem: string;
  problemCode: 'env_not_set' | 'no_master_key' | 'master_key_mismatch' | 'legacy_fingerprint' | 'unrecognized_format' | null;
  problemParams?: Record<string, string | number>;
}): string {
  const key = `credential.problem.${p.problemCode}` as MessageKey;
  if (!p.problemCode || !hasMessage(key)) return p.problem;
  return t('agentCfg.envProblem', { name: p.key, problem: t(key, p.problemParams ?? {}) });
}

const TABS: { key: Tab; labelKey: MessageKey; hintKey: MessageKey }[] = [
  { key: 'agents', labelKey: 'agentCfg.tab.agentsLabel', hintKey: 'agentCfg.tab.agents' },
  /**
   * ★ Split from "Agent config" into two pages, not two sections of one page.
   *
   *   The other page answers "what is this agent" (runtime, credential, model, tool and
   *   resource permissions); this one answers "which already-configured agent takes
   *   which role in this project". Mixing them was the original problem: the user was
   *   asked "which CLI" inside project settings, while the consequences of that choice
   *   were nowhere on the page.
   */
  { key: 'binding', labelKey: 'agentCfg.tab.binding', hintKey: 'agentCfg.tab.bindingDesc' },
  /**
   * ★★ Repositories and storage targets are no longer on this page; they merged into
   *   **Workspace sources** in the nav (pages/Settings/WorkspaceSources.tsx).
   *
   *   Neither is a property of an agent — both are project-level (or org-level)
   *   resource registries, and one monorepo referenced by five agents or one bucket by
   *   three is entirely normal. Hanging them under this page both asserted the wrong
   *   ownership and made them unfindable: someone who wants to register a repository or
   *   mount a data directory is not thinking about agents at all.
   *
   *   The three tabs that remain really are agent properties: what it is, which role it
   *   plays in the project, and which engineering conventions it works under.
   */
  { key: 'conventions', labelKey: 'agentCfg.tab.conventions', hintKey: 'agentCfg.tab.conventionsDesc' },
];

export function AgentConfigPage() {
  const t = useT();
  const { projectId } = useParams<{ projectId: string }>();
  /**
   * ★★ The active tab lives in the URL.
   *
   *   A blocked reason on the board offers a direct button like "go grant main-agent
   *   access" — it has to land on **that specific tab**, not dump the person on this
   *   page's first tab to hunt for it (issue log #12). `?tab=` also makes the page
   *   bookmarkable and shareable.
   * ★ An unrecognized value falls back to the default tab, not a blank screen.
   */
  const [params, setParams] = useSearchParams();
  const tab: Tab = (['agents', 'binding', 'conventions'] as const).find(
    (k) => k === params.get('tab'),
  ) ?? 'agents';
  const setTab = (next: Tab) => {
    const q = new URLSearchParams(params);
    q.set('tab', next);
    setParams(q, { replace: true });
  };
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
            <Button
              key={item.key}
              variant={tab === item.key ? 'neutral' : 'ghost'}
              onClick={() => setTab(item.key)}
              title={t(item.hintKey)}
              className={clsx(
                'h-auto px-3 py-1 text-xs',
                tab !== item.key && 'text-slate-600 hover:bg-slate-100',
              )}
            >
              {t(item.labelKey)}
            </Button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {tab === 'agents' && <AgentsSection projectId={projectId} />}
        {tab === 'binding' && <ProjectAgentSection projectId={projectId} />}
        {tab === 'conventions' && <ConventionsSection projectId={projectId} />}
      </div>
    </div>
  );
}

// ── Agents ────────────────────────────────────────────────────────────

/**
 * ★★ 这一页挂在**某个项目**下面（路由是 /projects/:projectId/settings），
 *   所以在这里建的 Agent 天然属于这个项目，建完直接入项目成员。
 *
 *   列表本身仍然是**组织级**的（listAgentsAdmin 按 orgId 查）—— 那是刻意的：
 *   「组织里有它、但这个项目还没加进来」正是用户需要在这一页看到的状态。
 *   projectId 只影响「新建的那个进哪儿」。
 */
function AgentsSection({ projectId }: { projectId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<AgentAdminRow | 'new' | null>(null);
  /**
   * ★ Config keys the platform did not recognize at save time.
   *
   *   They **were saved** (the config is free-form JSON), but they still have to be
   *   surfaced: "deliberately passing a key the platform does not know yet" and "typed
   *   the key name wrong" look identical once stored, and the second will never take
   *   effect — with no warning, nothing on screen would ever hint at it.
   */
  const [unknownKeys, setUnknownKeys] = useState<string[]>([]);
  /**
   * ★★ "The delete request succeeded, but the agent is still there."
   *
   *   An agent with execution history, named as a requirement's PRD author, or still
   *   bound to a project role is converted to disabled instead (deleteAgent on the
   *   server) — which is correct, but unsaid, all the user sees is "I clicked delete and
   *   it is still in the list", i.e. "the delete button is broken". The reason the
   *   server returns names what holds it and where to go next, so it must be shown.
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
    /** A notice left by the previous delete must not carry into this one — it is about a different agent */
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
        ★ This talks about **how** it is stored, not whether it can be stored.
          Saving works fine with no master key configured — the value just goes into the
          database in the clear. Worth knowing, but not a reason to block the work.
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
          {t('agentCfg.unknownKeysNotice', { keys: joinList(unknownKeys) })}
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
              /** The error attaches only to the card being deleted: on every card it reads as "none of them can be deleted" */
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
          agent={editing === 'new' ? null : editing}
          projectId={projectId}
          onClose={() => setEditing(null)}
          /**
           * ★ Close the dialog whether or not unknown keys turned up.
           *   Keeping it open so the user can "read it and then close" leaves a form that
           *   still thinks it is in create mode while the agent has already been created —
           *   one more click on save and there are two agents.
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
 * ★ Once the connection layer was removed, "who is using this credential" lost its
 *   natural home. This block puts it back — before a rotation you can see at a glance
 *   how many agents are affected, and why the env: form only needs changing in one
 *   place.
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
            <span className="text-slate-500">{joinList(r.agents)}</span>
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
   * ★ The three kinds of "unusable" are shown separately.
   *   Collapsed into one word, the user cannot tell whether to install a dependency,
   *   replace a key, or pick a different agent.
   */
  const health = !agent.registered
    ? { tone: 'error' as const, text: runtimeProblemText(agent) }
    : !agent.credentialUsable && agent.credentialHint
      ? { tone: 'error' as const, text: credentialProblemText(agent) }
      : /*
         * ★ An unresolvable reference in the environment table is the same class of
         *   problem as an unusable credential: the config looks intact and only blows up
         *   at dispatch, and the error never points at the variable that was never set.
         */
        agent.runtimeConfigProblems.length > 0
        ? { tone: 'error' as const, text: envProblemText(agent.runtimeConfigProblems[0]!) }
        : !agent.reachable
          ? { tone: 'warning' as const, text: agent.problem ?? t('agentCfg.health.probeFailed') }
          : { tone: 'ok' as const, text: t('agentCfg.health.ready') };

  /** Show only settings that differ from the defaults — listing them all drowns the few that were actually changed */
  const overrides = spec
    ? spec.fields.filter(
        (f) =>
          agent.runtimeConfig[f.key] !== undefined &&
          JSON.stringify(agent.runtimeConfig[f.key]) !== JSON.stringify(f.default),
      )
    : [];

  /**
   * ★ Keys the platform does not recognize appear on the card too.
   *   They are passed to the runtime just the same; the platform simply does not know
   *   what they are. Hidden, a config with a typo'd key name looks exactly like a clean
   *   one on this page.
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
          ★★ 这一格以前显示「承接范围」，空着时还专门标黄提醒。它连同
            applicableTypes 一起没了 —— 那一栏的空值是建 Agent 时的默认值，
            于是这个提醒对**每一个**新建的 Agent 都亮着，而它要提醒的东西
            用户在配置页上压根填不了。现在承接范围恒定是「全部」，
            这一格改说访问边界，那才是还需要被看见的事。
        */}
        {/*
          ★ 「有没有被收窄过」照实说。恒定显示「全项目访问」的话，一个
            真被限制过的 Agent 在列表上和没限制过的长得一模一样 ——
            而排查「它为什么推不了分支」时，这一格正是第一个被看的地方。
        */}
        <Field label={t('agent.access.field')}>
          {agent.ceiling.capabilityCeiling === null &&
          agent.ceiling.deniedCapabilities.length === 0 ? (
            t('agent.access.fullProject')
          ) : (
            <span className="text-amber-700">{t('agentCfg.form.restrictedNow')}</span>
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
          <Button
            variant="link"
            onClick={() => setShowCaps((v) => !v)}
            className="h-auto p-0 text-[11px] font-normal text-slate-500 underline hover:text-slate-700"
          >
            {showCaps ? t('agentCfg.collapseCapabilities') : t('agentCfg.capabilityList', { count: agent.capability.missing.length })}
          </Button>
          {showCaps && (
            <div className="mt-2 space-y-1">
              {/*
                ★ No silent degradation: which capability is missing and what it costs are
                  both laid out. Before dispatching a high-risk task, the user deserves to
                  know that "pause" on this agent actually means "terminate".
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

/**
 * 建 / 改一个 Agent。
 *
 * ★★ 建一个 Agent 只问三件事：**叫什么、用哪个运行时、凭证是什么**。
 *
 *   这张表以前还问四件用户在那个时刻答不上来的事：它接什么类型的活、
 *   它有哪些 Skill Tag、它的能力上限、它的硬拒绝清单。四件的共同点是
 *   「要先跑过一次才知道答案」，而答不上来的人会跳过 —— 跳过的默认值恰好是
 *   最坏的那一种（空数组 = 什么都不接），于是新建出来的 Agent 一动不动，
 *   页面上却全绿。
 *
 * ★ 运行时的执行参数（型号、端点、并发、超时、token 上限）不是「答不上来」，
 *   是「大多数时候不用改」—— 它们收进 Advanced settings，默认值直接可用。
 *
 * ★ 权限收窄留在**编辑**态的 Restrict access 里，建的时候不出现：
 *   默认是全项目访问，要收窄是一个事后的、明确的决定。
 *
 * Creating an agent asks for a name, a runtime and a credential. Everything the
 * old form asked that a user could not yet answer — what work it takes on, its
 * skill tags, its permission boundary — is gone: the answer people gave when
 * they could not answer was "skip", and skip stored the worst of the available
 * meanings.
 */
export function AgentForm({
  kinds,
  encryptsInline,
  agent,
  projectId,
  onClose,
  onSaved,
}: {
  kinds: RuntimeKindSpec[];
  /** Whether a pasted secret is stored encrypted. Both work; it only changes the hint */
  encryptsInline: boolean;
  agent: AgentAdminRow | null;
  /**
   * ★★ 在哪个项目里建的。新建时随请求送上去，服务端把它加进这个项目。
   *
   *   少了它，用户在项目配置页建完 Agent，还得再去「成员与角色」把它加一遍 ——
   *   而漏掉那一步的表现是「建好了、看着正常、就是永远派不到活」。
   */
  projectId: string;
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
  /**
   * ★ 负责人默认就是当前登录的人，不要求用户额外做一次选择。
   *   「这个 Agent 出事找谁」的默认答案是「建它的人」，而那几乎总是对的；
   *   要改的人在 Advanced settings 里改。
   */
  const [ownerId, setOwnerId] = useState(agent?.ownerId ?? currentUser ?? '');

  /** 运行时执行参数 —— 收在 Advanced settings 里，默认值直接可用 */
  const [maxConcurrency, setMaxConcurrency] = useState(String(agent?.maxConcurrency ?? 3));
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(agent?.timeoutSeconds ?? 1800));
  const [tokenLimitPerRun, setTokenLimitPerRun] = useState(
    agent?.tokenLimitPerRun === null || agent?.tokenLimitPerRun === undefined
      ? ''
      : String(agent.tokenLimitPerRun),
  );
  const [tokenLimitDaily, setTokenLimitDaily] = useState(
    agent?.tokenLimitDaily === null || agent?.tokenLimitDaily === undefined
      ? ''
      : String(agent.tokenLimitDaily),
  );
  const [showAdvanced, setShowAdvanced] = useState(false);

  /**
   * ★★ 事后限制 —— 只在**编辑**态出现，而且默认收起。
   *
   *   建的时候不问权限边界：那时候用户还不知道这个 Agent 会用到什么，
   *   而问一个答不上来的问题只会换来一份随手抄的配置。默认是全项目访问，
   *   真要收窄是一个明确的、事后的决定，所以入口低频、折叠、写明当前状态。
   *
   * ★ `null` = 不设上限，和「一条都不给」相反。开关表达它，不让空清单兼任两种含义。
   */
  const [restricting, setRestricting] = useState(
    agent !== null &&
      (agent.ceiling.capabilityCeiling !== null || agent.ceiling.deniedCapabilities.length > 0),
  );
  const [limited, setLimited] = useState(agent?.ceiling.capabilityCeiling !== null);
  const [ceiling, setCeiling] = useState<string[]>(
    agent?.ceiling.capabilityCeiling ?? [...DEFAULT_CEILING],
  );
  const [deniedCapabilities, setDeniedCapabilities] = useState<string[]>(
    agent?.ceiling.deniedCapabilities ?? [],
  );
  const [reason, setReason] = useState('');
  /**
   * ★ 说明书默认**收起**。
   *   它当初默认展开是因为 JSON 框里没有标签，收起来就没人知道该写什么；
   *   现在默认是逐键表单，每个字段旁边自带说明与默认值 ——
   *   再摆一份完整参照表只是重复，而重复的说明会让人怀疑哪份是新的。
   */
  const [showReference, setShowReference] = useState(false);

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
        maxConcurrency: positiveOr(maxConcurrency, 3),
        timeoutSeconds: positiveOr(timeoutSeconds, 1800),
        /** ★ 空 = 不限制，送 null；`0` 不是「不限制」，服务端会拒 */
        tokenLimitPerRun: positiveOrNull(tokenLimitPerRun),
        tokenLimitDaily: positiveOrNull(tokenLimitDaily),
        ...(credential.trim() ? { credential: credential.trim() } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      };

      if (!agent) {
        /**
         * ★★ 建的时候一栏权限都不送。
         *   服务端据此写「不设上限、无硬拒绝」，实际能做什么由项目里的默认
         *   档案（全项目访问）决定 —— 而这份表单不再需要用户理解那句话。
         */
        return api.createAgent({ ...body, projectId });
      }
      return api.updateAgent(agent.id, {
        ...body,
        /**
         * ★ 没展开 Restrict access 时，权限那两栏**原样送回**，不是送空。
         *   送空会把一个正在生效的限制悄悄解除掉，而用户这次只是来改个超时。
         */
        capabilityCeiling: restricting
          ? // ★ 不设上限时送 null，不是空数组 —— 两者含义相反
            (limited ? ceiling : null)
          : agent.ceiling.capabilityCeiling,
        deniedCapabilities: restricting ? deniedCapabilities : agent.ceiling.deniedCapabilities,
      });
    },
    onSuccess: (result) => onSaved(result.unknownConfigKeys ?? []),
  });

  const jsonProblem = Object.values(jsonErrors)[0] ?? null;

  /**
   * ★ 「和打开时不一样」才算改过。
   *   这个表单有十几个字段，逐个和初始值比是唯一诚实的判据 ——
   *   用「碰过表单」当判据的话，只是滚动一下也会触发确认，
   *   而每次都弹的确认框等于没有确认框（问题记录 #26）。
   */
  const dirty =
    name !== (agent?.name ?? '') ||
    type !== (agent?.type ?? 'code') ||
    description !== (agent?.description ?? '') ||
    credential.trim() !== '' ||
    endpoint !== (agent?.endpoint ?? '') ||
    ownerId !== (agent?.ownerId ?? currentUser ?? '') ||
    maxConcurrency !== String(agent?.maxConcurrency ?? 3) ||
    timeoutSeconds !== String(agent?.timeoutSeconds ?? 1800) ||
    tokenLimitPerRun !== (agent?.tokenLimitPerRun == null ? '' : String(agent.tokenLimitPerRun)) ||
    tokenLimitDaily !== (agent?.tokenLimitDaily == null ? '' : String(agent.tokenLimitDaily)) ||
    JSON.stringify(config) !== JSON.stringify(agent?.runtimeConfig ?? {}) ||
    kind !== (agent?.runtimeKind ?? kinds[0]?.kind ?? 'mock');
  useUnsavedGuard(dirty);
  const close = () => {
    if (confirmClose(dirty)) onClose();
  };

  return (
    <Modal
      onClose={close}
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
            <Button variant="outline" size="sm" onClick={close}>
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

        <Labeled label={t('agentCfg.form.name')}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('agentCfg.form.namePlaceholder')} />
        </Labeled>

        {/*
          ★★ 职责说明单独成区，紧跟名字，而不是夹在「类型」和「运行时」中间。
            它是这段配置里**唯一会进 prompt** 的东西 —— 换句话说，它决定
            这个 Agent 干活时是什么样子。而它此前是两行高的一个输入框，
            上下被凭证、端点、25 行 JSON 挤着，看起来像个可填可不填的备注
            （问题记录 #17）。
          ★ 空着时给一份可以照着改的样板，而不是一句「描述这个 Agent」。
            「Do all tasks」这种回答不是用户偷懒，是问法太空 ——
            给出样板之后，用户改的是内容，不是从零想一段话。
        */}
        <div className="rounded border border-brand/30 bg-brand/5 p-2">
          <div className="mb-1 flex flex-wrap items-baseline gap-1.5">
            <span className="text-[11px] font-semibold text-slate-800">
              {t('agentCfg.form.description')}
            </span>
            <span className="rounded bg-brand/10 px-1 text-[10px] text-brand">
              {t('agentCfg.form.descriptionBadge')}
            </span>
          </div>
          <p className="mb-1.5 text-[11px] text-slate-600">
            {t('agentCfg.form.descriptionHelp')}
          </p>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={6}
            placeholder={t('agentCfg.form.descriptionPlaceholder')}
          />
          {!description.trim() && (
            <Button
              variant="link"
              onClick={() => setDescription(t('agentCfg.form.descriptionTemplate'))}
              className="mt-1 h-auto p-0 text-[11px] font-normal text-slate-500 underline hover:text-slate-700"
            >
              {t('agentCfg.form.useTemplate')}
            </Button>
          )}
        </div>

        {/* ── 运行时 ── */}
        <div className="rounded border border-slate-200 bg-slate-50 p-2">
          <p className="mb-2 text-[11px] font-medium text-slate-700">
            {t('agentCfg.form.runtime')}
          </p>

          <Labeled label="Headless CLI">
            <Select value={kind} onValueChange={switchKind}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {kinds.map((k) => (
                  <SelectItem key={k.kind} value={k.kind}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
              /*
                ★ 走词条，不用服务端送来的那句。服务端那份是中文散文，
                  英文界面上会整段漏出来；它仍然保留在接口里给日志与
                  存量客户端当兜底。
              */
              help={t('agentCfg.credentialHelpText')}
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

        </div>

        {/*
          ── Advanced settings ──

          ★★ 默认**收起**。里面的每一项都有一个直接可用的默认值：
            并发 3、超时 30 分钟、token 不限、端点用 CLI 自己的。
            把它们摊在主表单上，会让「建一个 Agent」看起来像是要先做六个决定 ——
            而这六个决定里，用户在建的那一刻一个也答不上来。

          ★ 「模型」在运行时配置里（每种 CLI 自己的 `model` 键），这里**不再开一栏**：
            同一件事两个入口，迟早出现两处填了不同值、而谁也说不清哪个生效。
        */}
        <div className="rounded border border-slate-200 bg-slate-50 p-2">
          <Button
            variant="link"
            onClick={() => setShowAdvanced((v) => !v)}
            className="h-auto p-0 text-[11px] font-medium text-slate-700 hover:text-slate-900"
          >
            {showAdvanced ? '▾ ' : '▸ '}
            {t('agentCfg.form.advanced')}
          </Button>
          <p className="mt-0.5 text-[11px] text-slate-500">{t('agentCfg.form.advancedHelp')}</p>

          {showAdvanced && (
            <div className="mt-2 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Labeled label={t('agentCfg.form.type')} help={t('agentCfg.form.typeHelp')}>
                  <Select value={type} onValueChange={setType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {/* ★ 参数别叫 t —— 这个文件里 t 是 i18n 函数，遮蔽掉它下次改这段会很意外 */}
                      {['code', 'test', 'review', 'research', 'ops'].map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Labeled>
                <Labeled label={t('agentCfg.form.owner')} help={t('agentCfg.form.ownerHelp')}>
                  <Select
                    value={toSelectValue(ownerId)}
                    onValueChange={(v) => setOwnerId(fromSelectValue(v))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SELECT_EMPTY}>{t('agentCfg.form.choose')}</SelectItem>
                      {(users.data?.users ?? []).map((u) => (
                        <SelectItem key={u.id} value={u.id}>
                          {u.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Labeled>
              </div>

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
                ★★ 默认是**逐键的表单**，JSON 是逃生口 —— 此前正好反过来。
                  schema 里写着每个键的类型、取值范围、默认值和影响范围，
                  而界面把它们全降级成一个 25 行的文本框（问题记录 #18 / #46）。
                ★ 逃生口不能封：平台不认识的键（新版 CLI 刚加的参数）只能从
                  那儿进来，而服务端本来就照收。
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
                {spec ? (
                  <RuntimeConfigForm
                    key={kind}
                    spec={spec}
                    value={withDefaults(spec, config)}
                    onChange={setConfig}
                    renderJson={() => (
                      <JsonInput
                        /* 换 CLI 类型时重新挂载，否则文本框还留着上一种的内容 */
                        key={kind}
                        errorKey="__config__"
                        value={withDefaults(spec, config)}
                        onChange={setConfig}
                        onError={setJsonError}
                        rows={14}
                      />
                    )}
                  />
                ) : (
                  <JsonInput
                    key={kind}
                    errorKey="__config__"
                    value={config}
                    onChange={setConfig}
                    onError={setJsonError}
                    rows={14}
                  />
                )}
              </Labeled>

              {/*
                ★ 说明书默认**收起**了。表单模式下每个字段旁边就带着自己的
                  说明、默认值与影响标记 —— 再摆一份完整的参照表是重复，
                  而重复的说明会让人怀疑哪一份是新的。切到 JSON 模式的人
                  仍然需要它，所以入口留着。
              */}
              {spec && spec.fields.length > 0 && (
                <div>
                  <Button
                    variant="link"
                    onClick={() => setShowReference((v) => !v)}
                    className="h-auto p-0 text-[11px] font-normal text-slate-500 underline hover:text-slate-700"
                  >
                    {showReference
                      ? t('agentCfg.form.collapseOptions')
                      : t('agentCfg.form.optionsCount', { count: spec.fields.length })}
                  </Button>
                  {showReference && <ConfigReference fields={spec.fields} />}
                </div>
              )}

              {agent && agent.runtimeConfigProblems.length > 0 && (
                <div className="space-y-0.5">
                  {agent.runtimeConfigProblems.map((p) => (
                    <p key={p.key} className="text-[11px] text-rose-600">
                      ⚠ {envProblemText(p)}
                    </p>
                  ))}
                </div>
              )}

              {/*
                ★★ 这四栏是**闸门**，不是偏好：并发满了、超时到了、token 用尽了，
                  调度器会当场把这个 Agent 淘汰掉，并把原因写进阻塞详情。
                  所以它们的默认值必须是「够用」而不是「保险」—— 一个默认为 0
                  的额度会让每一个新建的 Agent 立刻停摆。
                ★ token 两栏留空 = 不限制。写 0 不是「不限制」，服务端会拒。
              */}
              <div className="grid grid-cols-2 gap-2">
                <Labeled
                  label={t('agentCfg.form.maxConcurrency')}
                  help={t('agentCfg.form.maxConcurrencyHelp')}
                >
                  <Input
                    value={maxConcurrency}
                    onChange={(e) => setMaxConcurrency(e.target.value)}
                    inputMode="numeric"
                    placeholder="3" />
                </Labeled>
                <Labeled
                  label={t('agentCfg.form.timeout')}
                  help={t('agentCfg.form.timeoutHelp')}
                >
                  <Input
                    value={timeoutSeconds}
                    onChange={(e) => setTimeoutSeconds(e.target.value)}
                    inputMode="numeric"
                    placeholder="1800" />
                </Labeled>
                <Labeled
                  label={t('agentCfg.form.tokenPerRun')}
                  help={t('agentCfg.form.tokenPerRunHelp')}
                >
                  <Input
                    value={tokenLimitPerRun}
                    onChange={(e) => setTokenLimitPerRun(e.target.value)}
                    inputMode="numeric"
                    placeholder={t('agentCfg.form.unlimited')} />
                </Labeled>
                <Labeled
                  label={t('agentCfg.form.tokenDaily')}
                  help={t('agentCfg.form.tokenDailyHelp')}
                >
                  <Input
                    value={tokenLimitDaily}
                    onChange={(e) => setTokenLimitDaily(e.target.value)}
                    inputMode="numeric"
                    placeholder={t('agentCfg.form.unlimited')} />
                </Labeled>
              </div>
            </div>
          )}
        </div>

        {/*
          ── Restrict access ──

          ★★ 只在**编辑**态出现，而且默认收起、默认状态写在标题旁边。

            建 Agent 时不问权限边界：那时候用户还不知道它会用到什么，而问一个
            答不上来的问题只会换来一份从别处抄来的配置。默认是全项目访问 ——
            项目里的活它都能干，平台控制面与人类专属能力（改权限、改治理、
            代人审批、部署、写库、读凭证）一条都拿不到，且后两类任何配置都放不开。

          ★ 没展开就不动这两栏（见 save 里的原样回送）：用户这次可能只是来改超时。
        */}
        {agent && (
          <div className="rounded border border-slate-200 bg-slate-50 p-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <Button
                variant="link"
                onClick={() => setRestricting((v) => !v)}
                className="h-auto p-0 text-[11px] font-medium text-slate-700 hover:text-slate-900"
              >
                {restricting ? '▾ ' : '▸ '}
                {t('agentCfg.form.restrict')}
              </Button>
              <span className="text-[11px] text-slate-500">
                {agent.ceiling.capabilityCeiling === null &&
                agent.ceiling.deniedCapabilities.length === 0
                  ? t('agent.access.fullProject')
                  : t('agentCfg.form.restrictedNow')}
              </span>
            </div>

            {restricting && (
              <div className="mt-2">
                {/*
                  ★★ 这里曾经是三个字段：allowedTools、deniedTools、resourceScopes。
                    前两个要求用户先懂某个 CLI 的工具名，第三个把组织级配置
                    当成了项目级授权用。现在：上限在这一页，实际授权在项目里
                    选档案（项目设置 → 项目 Agent → 生效权限）。
                */}
                <Label className="flex items-start gap-2 text-xs font-normal">
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
                </Label>

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
            )}
          </div>
        )}
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
 * 表单里的数字栏 → 服务端要的数。
 *
 * ★ 空串、非数字、非正数一律回落到默认值，而不是送一个 `NaN` 或 `0` 上去：
 *   并发填成 0 的后果是这个 Agent 立刻被判「已满载」而永远不被派活，
 *   而报错会出现在几小时后的看板上，不在填错的这一刻。
 */
function positiveOr(raw: string, fallback: number): number {
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

/**
 * 同上，但**留空 = 不限制**（送 null）。
 *
 * ★ null 与 0 在这里含义相反：null 是「不设上限」，0 会被服务端当成非法值拒掉。
 *   让空串走到 null，是为了让「我不想管这一栏」有一个正确的表达方式。
 */
function positiveOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
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

function formatValue(v: unknown): string {
  if (Array.isArray(v)) return joinList(v) || t('agentCfg.emptyValue');
  /**
   * ★ JSON 对象只列键名。
   *   值里可能有网关地址、也可能有 `secret://saved` 这种占位符 ——
   *   卡片上一个也不该出现：前者是噪音，后者会让人以为凭证存坏了。
   */
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>);
    return keys.length > 0 ? joinList(keys) : t('agentCfg.emptyValue');
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
                    {t('agentCfg.convention.appliesTo', { types: joinList(c.appliesTo) })}
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
        <Label className="block">
          <span className="text-xs font-medium text-slate-700">{t('agentCfg.conv.titleField')}</span>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('agentCfg.conv.titlePlaceholder')}
            className="mt-1" />
        </Label>

        <Label className="block">
          <span className="text-xs font-medium text-slate-700">{t('agentCfg.conv.content')}</span>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            placeholder={t('agentCfg.conv.contentPlaceholder')}
            className="mt-1 font-mono"
          />
        </Label>

        {/*
          ★ 这一格不像上面两格那样把控件包在 label 里，而是 htmlFor 关联。
            Radix 的 Select 触发器是 <Button variant="ghost" className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent">，包进 label 之后点标签文字
            不会打开下拉（Radix 在 pointerdown 上开，label 转发的是 click）。
            htmlFor 两边都成立。

            Unlike the two fields above, this one associates by htmlFor instead
            of wrapping: the Radix trigger is a button that opens on pointerdown,
            and a label only forwards a click, so wrapping would make the label
            text dead.
        */}
        <div>
          <Label htmlFor="conv-priority" className="text-slate-700">
            {t('agentCfg.conv.priority')}
          </Label>
          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger id="conv-priority" className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="must_read">{t('agentCfg.conv.mustReadOption')}</SelectItem>
              <SelectItem value="reference">{t('agentCfg.conv.referenceOption')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
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
                    <Select
                      value={toSelectValue(bound?.agentId)}
                      disabled={save.isPending}
                      onValueChange={(v) =>
                        save.mutate({ role, agentId: fromSelectValue(v) || null, priority: 0 })
                      }
                    >
                      <SelectTrigger className="ml-auto w-56" aria-label={t(labelKey)}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {/* ★ 解绑不是「没配」，是显式回到「按项目成员自动挑」 */}
                        <SelectItem value={SELECT_EMPTY}>{t('binding.unbound')}</SelectItem>
                        {data.available.map((a) => (
                          <SelectItem key={a.agentId} value={a.agentId}>
                            {a.name} · {a.runtimeKind}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/*
                    ★★ 备选只在主 Agent 已经绑了之后才出现。
                      没有主的时候先问备选是本末倒置 —— 而且那时「退到备选」
                      根本无从谈起。
                  */}
                  {bound && (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] text-slate-500">{t('binding.fallback')}</span>
                      <Select
                        value={toSelectValue(fallback?.agentId)}
                        disabled={save.isPending}
                        onValueChange={(v) =>
                          save.mutate({ role, agentId: fromSelectValue(v) || null, priority: 1 })
                        }
                      >
                        <SelectTrigger className="ml-auto w-56" aria-label={t('binding.fallback')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={SELECT_EMPTY}>{t('binding.noFallback')}</SelectItem>
                          {data.available
                            // ★ 主 Agent 不能同时当自己的备选
                            .filter((a) => a.agentId !== bound.agentId)
                            .map((a) => (
                              <SelectItem key={a.agentId} value={a.agentId}>
                                {a.name} · {a.runtimeKind}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
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
 * 点开 Restrict access 时，能力上限的初始勾选。
 *
 * ★★ 它对齐的是 **standard_executor**（在隔离工作区里干活），而不是当前默认的
 *   full_project —— 这是刻意的：会点开这个折叠区的人，来意就是收窄。
 *   给一份等于「不收窄」的初始勾选，等于让他先自己取消一遍。
 *
 * ★ 它只是这个折叠区的起点，不是新建 Agent 的默认值。新建时压根不送这一栏
 *   （见 AgentForm 的 save），服务端写的是「不设上限」。
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
        <Label key={c.key} className="flex items-start gap-1.5 text-[11px] font-normal">
          <Checkbox
            checked={value.includes(c.key)}
            onCheckedChange={() => toggle(c.key)}
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
        </Label>
      ))}
    </div>
  );
}
