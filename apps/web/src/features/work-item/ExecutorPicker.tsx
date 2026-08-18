import { useT } from '../../lib/i18n';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { AssigneeChip } from '../../components/AssigneeChip';
import { GatedButton } from '../../components/Gated';
import type { ExecutorCandidates } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  SELECT_EMPTY,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  fromSelectValue,
  toSelectValue,
} from '@/components/ui/select';

/**
 * 卡片执行者选择器。
 *
 * ★★ 「选执行者」与「开始执行」是两个按钮，不是一个动作。
 *
 *   此前看板上根本没有这个入口，唯一能指派的路径是 POST /assign ——
 *   而它在保存执行者的同一次调用里就把 Run 派了出去。用户以为自己只是
 *   在下拉框里选了个人，实际上 Agent 立刻开始改文件、开始烧预算。
 *   一个「选择」不该有不可逆的副作用。
 *
 * ★★ 不可选的 Agent 也列出来，并且写清楚为什么不可选。
 *
 *   只列可选项的话，用户看到的是一个空下拉框，然后无从下手：
 *   是没配 Agent、没加进项目、满载了、还是运行时没注册？
 *   这四种原因的下一步动作完全不同（去配置页 / 去成员页 / 等一会 /
 *   查部署）。页面文档 04 §5.4 要求展示匹配依据，这里把反面依据一并给出。
 */
export function ExecutorPicker({
  workItemId,
  projectId,
  status,
}: {
  workItemId: string;
  projectId: string;
  status: string;
}) {
  const t = useT();
  const qc = useQueryClient();

  const candidates = useQuery({
    queryKey: qk.workItemCandidates(workItemId),
    queryFn: () => api.workItemCandidates(workItemId),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: qk.workItem(workItemId) });
    void qc.invalidateQueries({ queryKey: qk.workItemCandidates(workItemId) });
    // ★ boardAll 而不是 board(projectId, filters)：换执行者要让**所有**筛选组合
    //   下的看板缓存失效，否则切一下筛选就又看到旧的执行者
    void qc.invalidateQueries({ queryKey: qk.boardAll(projectId) });
  };

  /**
   * ★★ 有 Run 在跑时，服务端会拒掉改派并要求说明怎么处置那次执行。
   *
   *   这不是错误，是一次必须由人回答的问题：终止后立刻交接、让它跑完、
   *   还是终止并转人工。默认哪一个都会在某些场景下出错 —— 一次跑了半小时、
   *   快要完成的执行被静默终止，和一次早就跑偏的执行被放任跑完，
   *   都是这里选错的后果。
   */
  const [pendingTakeover, setPendingTakeover] = useState<{
    body: { agentId?: string | null; userId?: string | null };
    runIds: string[];
  } | null>(null);

  const setAssignee = useMutation({
    mutationFn: (body: {
      agentId?: string | null;
      userId?: string | null;
      takeover?: 'terminate' | 'wait' | 'handover';
    }) => api.setWorkItemAssignee(workItemId, body),
    onSuccess: () => {
      setPendingTakeover(null);
      invalidate();
    },
    onError: (e, body) => {
      const runIds =
        e instanceof ApiError
          ? ((e.details as { runIds?: string[] } | undefined)?.runIds ?? null)
          : null;
      if (runIds) setPendingTakeover({ body, runIds });
    },
  });

  const start = useMutation({
    mutationFn: () => api.startWorkItem(workItemId),
    onSuccess: invalidate,
  });

  const d = candidates.data;
  if (!d) return null;

  /** ★ 与后端 assertStartable 同一份清单 —— 两边不一致会出现「按钮亮着但点了报错」 */
  const startable = ['ready', 'blocked', 'changes_requested'].includes(status);
  const current = d.current;
  const busy = setAssignee.isPending || start.isPending;

  return (
    <section className="rounded border border-slate-200 bg-white p-2">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
          {t('executor.title')}
        </h4>
        {current.executorId ? (
          <AssigneeChip
            actor={{
              type: current.executorType === 'agent' ? 'agent' : 'human',
              id: current.executorId,
              name: nameOf(d, current.executorId),
            }}
            size="sm"
          />
        ) : (
          <span className="text-[11px] text-slate-400">{t('executor.unassigned')}</span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <GatedButton
            permission="work_item.execute"
            projectId={projectId}
            disabled={!startable || busy || current.executorType !== 'agent'}
            onClick={() => start.mutate()}
            className="rounded bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-slate-700 disabled:opacity-40"
          >
            {start.isPending ? t('executor.starting') : t('executor.start')}
          </GatedButton>
        </div>
      </div>

      {/*
        ★ 「不能开始」的理由要写出来，而不是只把按钮灰掉。
          灰按钮回答不了「为什么」，用户只能猜。
      */}
      {!startable && (
        <p className="mt-1 text-[11px] text-slate-400">
          {t('executor.notStartable', { status })}
        </p>
      )}
      {startable && current.executorType !== 'agent' && (
        <p className="mt-1 text-[11px] text-slate-400">
          {current.executorType === 'human'
            ? t('executor.humanExecutor')
            : t('executor.pickAgentFirst')}
        </p>
      )}

      <div className="mt-1.5 space-y-1.5">
        <Row label={t('executor.agents')}>
          {d.agents.eligible.length === 0 && d.agents.ineligible.length === 0 ? (
            <span className="text-[11px] text-slate-400">{t('executor.noAgents')}</span>
          ) : (
            <Select
              value={toSelectValue(current.executorType === 'agent' ? current.executorId : '')}
              disabled={busy}
              onValueChange={(v) =>
                setAssignee.mutate({ agentId: fromSelectValue(v) || null, userId: null })
              }
            >
              <SelectTrigger className="w-full" aria-label={t('executor.agents')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SELECT_EMPTY}>{t('executor.autoAssign')}</SelectItem>
                {d.agents.eligible.map((a) => (
                  <SelectItem key={a.agentId} value={a.agentId}>
                    {a.name} · {a.runtimeKind ?? '—'}
                  </SelectItem>
                ))}
                {/*
                  ★ 不可选的进 disabled 分组而不是被删掉 —— 用户要看见它在那儿、
                    以及为什么选不了。删掉的话「我明明配了那个 Agent」无从解释。
                */}
                {d.agents.ineligible.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>{t('executor.unavailable')}</SelectLabel>
                    {d.agents.ineligible.map((a) => (
                      <SelectItem key={a.agentId} value={a.agentId} disabled>
                        {a.name} —— {a.reason}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          )}
        </Row>

        {/* ★ 匹配依据：用户要能反驳调度器的选择，而不是只能相信它 */}
        {d.agents.eligible.length > 0 && (
          <ul className="space-y-0.5">
            {d.agents.eligible.slice(0, 3).map((a) => (
              <li key={a.agentId} className="text-[11px] text-slate-500">
                <span
                  className={clsx(
                    'font-medium',
                    a.agentId === current.executorId ? 'text-slate-800' : 'text-slate-600',
                  )}
                >
                  {a.name}
                </span>
                <span className="ml-1 tabular-nums text-slate-400">
                  {t('executor.score', { score: a.score.toFixed(2) })}
                </span>
                {a.reasons.length > 0 && <span className="ml-1">· {a.reasons.join('、')}</span>}
              </li>
            ))}
          </ul>
        )}

        <Row label={t('executor.humans')}>
          <Select
            value={toSelectValue(current.executorType === 'human' ? current.executorId : '')}
            disabled={busy}
            onValueChange={(v) =>
              setAssignee.mutate({ userId: fromSelectValue(v) || null, agentId: null })
            }
          >
            <SelectTrigger className="w-full" aria-label={t('executor.humans')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SELECT_EMPTY}>{t('executor.noHuman')}</SelectItem>
              {d.humans.map((h) => (
                <SelectItem key={h.userId} value={h.userId}>
                  {h.name} · {h.role}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      </div>

      {pendingTakeover && (
        <div className="mt-1.5 rounded border border-amber-300 bg-amber-50 p-2">
          <p className="text-[11px] font-medium text-amber-900">
            {t('executor.takeoverTitle', { count: pendingTakeover.runIds.length })}
          </p>
          <p className="mt-0.5 text-[11px] text-amber-800">{t('executor.takeoverWhy')}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {(['terminate', 'wait', 'handover'] as const).map((mode) => (
              <Button
                key={mode}
                variant="outline"
                disabled={setAssignee.isPending}
                onClick={() => setAssignee.mutate({ ...pendingTakeover.body, takeover: mode })}
                className="h-auto border-amber-400 bg-white px-2 py-0.5 text-[11px] font-normal text-amber-900 shadow-none hover:bg-amber-100 hover:text-amber-900 disabled:opacity-40"
              >
                {t(`executor.takeover.${mode}` as const)}
              </Button>
            ))}
            <Button
              variant="ghost"
              onClick={() => setPendingTakeover(null)}
              className="h-auto px-1 py-0 text-[11px] font-normal text-slate-500 hover:bg-transparent"
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {/* ★ 改派拦截已经用上面那块专门表达了，不要再当成一条红色报错重复一遍 */}
      {((setAssignee.error && !pendingTakeover) || start.error) && (
        <p className="mt-1 rounded bg-rose-50 px-2 py-1 text-[11px] text-rose-700">
          {errorText(setAssignee.error ?? start.error)}
        </p>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Label className="block font-normal">
      <span className="text-[11px] text-slate-500">{label}</span>
      <div className="mt-0.5">{children}</div>
    </Label>
  );
}

function nameOf(d: ExecutorCandidates, id: string): string {
  const agent =
    d.agents.eligible.find((a) => a.agentId === id) ??
    d.agents.ineligible.find((a) => a.agentId === id);
  if (agent) return agent.name;
  return d.humans.find((h) => h.userId === id)?.name ?? id;
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}
