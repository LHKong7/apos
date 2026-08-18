import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { useT, type MessageKey } from '@/lib/i18n';
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
 * 项目里某个 Agent 的生效权限。
 *
 * ★★ 这一页刻意**不显示运行时工具名**。
 *
 *   `Read` / `Edit` / `Bash(npm test:*)` 是运行时的词汇，而运行时是 Agent 的
 *   一个属性，不是用户要做的选择。让用户在这里配工具名有三个后果：他得先
 *   懂某个 CLI；换运行时等于重配一遍；而最要命的是 `repo:write` 这一个词
 *   同时表示「在隔离工作区改文件」「推到远端」「合进主干」——
 *   三件风险差了两个数量级的事，在授权界面上长得一模一样。
 *
 *   这里显示的是**能力**（服务端已经算好并翻译成人话的那一份），
 *   以及一句「这条能力意味着什么」。
 *
 * ★ 数值全部来自服务端那一次求值，前端不自己算。前端再算一遍等于把求值器
 *   抄第二份，而两份的分歧会表现成「界面说它能推分支，实际派下去推不了」。
 *
 * This panel deliberately shows no runtime tool names. They are a runtime's
 * vocabulary, and one word (`repo:write`) used to cover three operations whose
 * risk differs by orders of magnitude. Everything shown comes from the server's
 * single evaluation — recomputing here would be a second evaluator, and the two
 * would disagree exactly where nobody is looking.
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
          {profile?.name ?? data.profileKey}
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
        ★ 「没配过」要说出来，而不是显示一份看起来像用户配的配置。
          两者在界面上一样的话，用户不知道这份权限是他定的还是平台给的默认。
      */}
      {data.usingDefault && (
        <p className="mt-1 text-[11px] text-slate-500">{t('access.usingDefault')}</p>
      )}

      {/*
        ★★ 档案有新版只**提示**，不自动升级。自动升级等于「平台改一次档案，
          所有 Agent 跟着变宽」—— 权限累积最典型的发生方式。
      */}
      {data.profileOutdated && <Notice tone="warning">{t('access.outdated')}</Notice>}

      <dl className="mt-2 space-y-1 text-[11px]">
        <div className="flex flex-wrap items-baseline gap-1">
          <dt className="text-slate-500">{t('access.capabilities')}：</dt>
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
                  {c.label}
                </span>
              ))
            )}
          </dd>
        </div>

        <div className="flex flex-wrap items-baseline gap-1">
          <dt className="text-slate-500">{t('access.resources')}：</dt>
          <dd className="text-slate-700">
            {data.resourceScopes.length === 0
              ? t('access.none')
              : data.resourceScopes
                  .map((s) => `${s.ref}（${t(`scopes.access.${s.access}` as MessageKey)}）`)
                  .join('、')}
          </dd>
        </div>
      </dl>

      {/*
        ★★ 运行时兜不住的限制必须显示。授权界面上这条能力和别处长得一样，
          而在这个运行时上它实际不生效 —— 不说的话，用户以为限制住了。
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
  const qc = useQueryClient();

  const [profileKey, setProfileKey] = useState(current.profileKey);
  const [scopes, setScopes] = useState<ScopeRow[]>(
    current.resourceScopes
      /**
       * ★ 平台默认给的那几条不进表单。它们不是用户配的 —— 放进来，
       *   用户一保存就把默认变成了显式配置，而两者的语义不同：
       *   显式配置在项目仓库登记变化时不会跟着走。
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
   * ★★ 保存前先问服务端「会发生什么」，用的是**保存那条路径同一个求值器**。
   *   前端自己比较两个档案的能力清单也能算出个差异，但那是第二份实现 ——
   *   而它和服务端的分歧会正好出现在最需要预览的那些复杂输入上
   *   （上限收窄、运行时不支持、资源范围升级）。
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
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {current.profiles.map((p) => (
              <SelectItem key={p.key} value={p.key}>
                {p.name}
              </SelectItem>
            ))}
            {/*
              ★ 迁移进来的授权（legacy_import）不是内置档案，选项里没有它。
                保留当前值，否则打开表单就把它换成了别的档案。
            */}
            {/* ★ `profileKey &&` 同 Members 那处：空串会让 Radix 抛错，不是少一项 */}
            {profileKey && !current.profiles.some((p) => p.key === profileKey) && (
              <SelectItem value={profileKey}>{profileKey}</SelectItem>
            )}
          </SelectContent>
        </Select>
      </Labeled>
      <p className="text-[11px] text-slate-500">
        {current.profiles.find((p) => p.key === profileKey)?.description}
      </p>

      <Labeled label={t('access.resources')}>
        <ResourceScopeEditor value={scopes} onChange={setScopes} projectId={projectId} />
      </Labeled>

      {impact && <ImpactSummary impact={impact} />}

      {/*
        ★ 原因框只在放宽时出现。收紧也要填理由的话，收紧就和放宽一样麻烦了，
          而我们恰恰希望收紧是随手能做的那件事。
      */}
      {impact?.requiresReason && (
        <Labeled label={t('access.reason')} help={t('access.reasonHelp')}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
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
 * 保存前的影响摘要。
 *
 * ★★ 说的是**后果**，不是配置差异。「新增 repository.push」对用户没有意义，
 *   「它将能把分支推到远端仓库」才有。目录里那句 consequence 就是为这里写的。
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
          {t('access.preview.removed')}：{impact.removedCapabilities.join('、')}
        </p>
      )}

      {impact.affectedResources.length > 0 && (
        <p className="mt-1">
          {t('access.preview.resources', { refs: impact.affectedResources.join('、') })}
        </p>
      )}
    </div>
  );
}
