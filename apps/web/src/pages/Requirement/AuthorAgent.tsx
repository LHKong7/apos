import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { useT } from '../../lib/i18n';
import { usePermissions } from '../../lib/permissions/usePermissions';
import type { RequirementDetail } from '../../lib/api/types';

/**
 * 「这条需求的 PRD 由谁写」——需求级的编写 Agent 指定（页面文档 03 §5.4）。
 *
 * ★★ 选择记在**需求**上，不是记在这一次分析上。
 *
 *   选完之后离开页面、过两天回来点「重新分析」，那个选择还得在 ——
 *   否则「选了 Agent 由它来写」就只是「这一次碰巧用了它」，
 *   下一次又悄悄换回项目绑定的那个，而界面上没有任何迹象。
 *
 * ★ 候选只列**本项目的 Agent 成员**，且只列适用类型含 requirement 的 ——
 *   与项目 Agent 绑定页同一条判据（http/project-agents.ts）。列出选了必然
 *   被服务端拒掉的那些，等于把校验推迟到提交之后。
 *
 * ★ 已经选中、但如今不在候选里的那个（被移出项目 / 停用 / 类型被取消勾选）
 *   必须仍然显示出来并说清后果。让它显示成「未指定」是最坏的处理：
 *   库里明明指着它，下一次分析也会照着它失败。
 *
 * Requirement-level pick of the agent that authors this PRD. The choice lives
 * on the requirement so it survives reloads and re-analysis; candidates are the
 * project's own agent members that can handle `requirement`; an already-picked
 * agent that no longer qualifies is still shown, with the consequence spelled
 * out, instead of silently rendering as "unset".
 */
export function AuthorAgent({
  projectId,
  requirementId,
  requirement: r,
  authorAgent,
  readOnly,
}: {
  projectId: string;
  requirementId: string;
  requirement: RequirementDetail['requirement'];
  authorAgent: RequirementDetail['authorAgent'];
  readOnly: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  /**
   * 正在保存的那个值。
   *
   * ★ 请求飞在路上时，下拉框要显示**用户刚选的那个**，不是服务端的旧值。
   *   不留这个 state 的话，受控 select 会在 onChange 之后立刻被旧值拉回去，
   *   看起来像是「点了没反应」。
   *
   * ★ 但它只活到 onSettled 为止：失败时回落到服务端的真值并把报错摆出来，
   *   而不是留在那个其实没保存成功的选项上 —— 乐观显示一旦跨过失败，
   *   就变成了骗人。
   */
  const [pending, setPending] = useState<{ id: string | null } | null>(null);

  const agents = useQuery({
    queryKey: qk.projectAgents(projectId),
    queryFn: () => api.projectAgents(projectId),
  });

  /**
   * ★ 没权限的人看到的应该是一个**灰着并说明原因**的下拉框，不是一个
   *   点下去收 403 的下拉框。这与 GatedButton 是同一条纪律 ——
   *   只是 select 没法直接套那个组件（它包的是 button）。
   *
   * ★ 灰掉不是权限：服务端仍然独立判一遍（rbac 里这条路要 requirement.edit）。
   */
  const perms = usePermissions(projectId);
  const denied = !perms.can('requirement.edit');

  const save = useMutation({
    mutationFn: (agentId: string | null) => api.setRequirementAuthorAgent(requirementId, agentId),
    onMutate: (agentId) => setPending({ id: agentId }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: qk.requirement(requirementId) });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('requirement.author.failed')),
    onSettled: () => setPending(null),
  });

  /**
   * ★ 与服务端同一条判据：能写 PRD = 适用类型含 requirement。
   *   这里放宽一点点的话，用户会选到一个保存时才被拒的 Agent，
   *   而那条报错出现在提交之后，不在选择的时候。
   */
  const eligible = (agents.data?.available ?? []).filter((a) =>
    a.applicableTypes.includes('requirement'),
  );

  const selectedId = r.authorAgentId;
  /** 选中的那个还在候选里吗 */
  const known = eligible.some((a) => a.agentId === selectedId);
  /**
   * 选中的那个已经不在候选里 —— 被移出项目，或适用类型被取消勾选。
   *
   * ★ 必须等候选**加载完**才敢这么说。列表还没回来时 eligible 是空的，
   *   不加这道判断的话，每次进页面都会先闪一句「已不是这个项目的成员」，
   *   而它多半是假的。
   */
  const orphaned = Boolean(agents.data) && Boolean(selectedId) && !known;
  const selectedName = authorAgent?.name ?? selectedId;
  /**
   * ★ 被移出项目时不再重复报「它停用了」：两条都成立时，
   *   「不是这个项目的成员」才是那条要先解决的。
   */
  const inactive =
    authorAgent && !orphaned && authorAgent.status !== 'active' ? authorAgent.status : null;

  return (
    <div className="mt-1 rounded border border-slate-200 bg-slate-50 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-slate-600">
          {t('requirement.author.label')}
        </span>
        <select
          value={(pending ? pending.id : selectedId) ?? ''}
          disabled={readOnly || denied || save.isPending || agents.isPending}
          title={denied ? perms.why('requirement.edit') : undefined}
          onChange={(e) => save.mutate(e.target.value || null)}
          aria-label={t('requirement.author.label')}
          className="w-64 rounded border border-slate-300 bg-white px-1.5 py-1 text-xs disabled:opacity-60"
        >
          {/* ★ 「未指定」是显式的一档，不是空白：它表示回到按项目绑定挑 */}
          <option value="">{t('requirement.author.auto')}</option>
          {eligible.map((a) => (
            <option key={a.agentId} value={a.agentId}>
              {a.name} · {a.runtimeKind}
              {a.status === 'active' ? '' : ` · ${a.status}`}
            </option>
          ))}
          {/*
            ★ 已选但不在候选里的那个也要有一项，否则 select 会落回「未指定」，
              界面上看起来像是从没选过 —— 而库里还指着它。
            ★ 用 known 而不是 orphaned：候选还在加载时也得有这一项，
              否则下拉框会先显示成「未指定」再跳回来。
          */}
          {selectedId && !known && <option value={selectedId}>{selectedName}</option>}
        </select>
        {save.isPending && (
          <span className="text-[11px] text-slate-400">{t('requirement.author.saving')}</span>
        )}
      </div>

      <p className="mt-0.5 text-[11px] text-slate-400">{t('requirement.author.hint')}</p>

      {orphaned && selectedName && (
        <p className="mt-0.5 text-[11px] text-amber-700">
          {t('requirement.author.gone', { name: selectedName })}
        </p>
      )}
      {inactive && authorAgent && (
        <p className="mt-0.5 text-[11px] text-amber-700">
          {t('requirement.author.inactive', { name: authorAgent.name, status: inactive })}
        </p>
      )}
      {/* ★ 一个可选项都没有时说清怎么才能有，而不是给一个空下拉框 */}
      {agents.data && eligible.length === 0 && !orphaned && (
        <p className="mt-0.5 text-[11px] text-amber-700">
          {t('requirement.author.noneEligible')}
        </p>
      )}
      {error && <p className="mt-0.5 text-[11px] text-rose-600">{error}</p>}
    </div>
  );
}
