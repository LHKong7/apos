import { useT } from '../../lib/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';

/**
 * 计划页上的逐任务执行者预分配。
 *
 * ★★ 批准之前就能排人，是这一页最该有的能力。
 *
 *   批准会把所有任务一次性放进待执行队列。在此之前不能逐条指定执行者的话，
 *   用户只有两个选择：全部交给调度器自动挑，或者批准之后再一张张打开卡片改。
 *   而人工任务尤其不能等 —— 批下去没人接的话它会停在那里不动
 *   （调度器不碰人工任务），这正是批准时那道「待认领」拦截在说的事。
 *
 * ★ 与卡片抽屉里的 ExecutorPicker 共用同一套接口（candidates + assignee），
 *   但**不**复用那个组件：这里是一行内的紧凑选择器，没有「开始执行」——
 *   计划还没批，任何一条都还不能开始。
 */
export function TaskAssignee({
  workItemId,
  planId,
  disabled,
}: {
  workItemId: string;
  planId: string;
  disabled: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();

  const candidates = useQuery({
    queryKey: qk.workItemCandidates(workItemId),
    queryFn: () => api.workItemCandidates(workItemId),
    // ★ 计划已批准就不再拉候选 —— 那时该去看板上改，这里的下拉是只读的
    enabled: !disabled,
  });

  const save = useMutation({
    mutationFn: (body: { agentId?: string | null; userId?: string | null }) =>
      api.setWorkItemAssignee(workItemId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.plan(planId) });
      void qc.invalidateQueries({ queryKey: qk.workItemCandidates(workItemId) });
    },
  });

  const d = candidates.data;
  if (!d) return null;

  const current =
    d.current.executorType === 'agent'
      ? `agent:${d.current.executorId}`
      : d.current.executorType === 'human'
        ? `human:${d.current.executorId}`
        : '';

  return (
    <select
      value={current}
      disabled={disabled || save.isPending}
      onChange={(e) => {
        const [kind, id] = e.target.value.split(':');
        save.mutate(
          kind === 'agent'
            ? { agentId: id, userId: null }
            : kind === 'human'
              ? { userId: id, agentId: null }
              : { agentId: null, userId: null },
        );
      }}
      className="w-40 shrink-0 rounded border border-slate-300 px-1 py-0.5 text-[11px]"
      aria-label={t('plan.assignTask')}
      title={save.error instanceof ApiError ? save.error.message : undefined}
    >
      <option value="">{t('executor.autoAssign')}</option>
      {d.agents.eligible.map((a) => (
        <option key={a.agentId} value={`agent:${a.agentId}`}>
          🤖 {a.name}
        </option>
      ))}
      {d.humans.map((h) => (
        <option key={h.userId} value={`human:${h.userId}`}>
          👤 {h.name}
        </option>
      ))}
      {/*
        ★ 不可选的也列出来（禁用），与抽屉里同一条理由：删掉的话
          「我明明配了那个 Agent」无从解释。
      */}
      {d.agents.ineligible.length > 0 && (
        <optgroup label={t('executor.unavailable')}>
          {d.agents.ineligible.map((a) => (
            <option key={a.agentId} value={`agent:${a.agentId}`} disabled>
              {a.name} —— {a.reason}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
