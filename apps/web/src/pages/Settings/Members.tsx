import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { relativeTime } from '../../lib/format';
import { CardSkeleton, ErrorState } from '../../components/states';
import { GatedButton, RoleBadge } from '../../components/Gated';
import { usePermissions } from '../../lib/permissions/usePermissions';
import { useAuthStore } from '../../stores/auth';
import type { ProjectRole } from '../../lib/api/types';

/**
 * 项目成员与角色（docs/tech/09-security.md §2.2）。
 *
 * ★★ 这一页是整套 RBAC 能不能落地的关键，而不是一个管理附属品。
 *
 *   一套改不了的权限体系，实践中的结局永远是「所有人共用一个账号」——
 *   因为换角色比换个人麻烦。权限模型的落地程度，取决于调整它有多容易。
 *
 * ★ 每个角色旁边写它能做什么，不是写角色名。「tech_lead」对一个业务负责人
 *   不构成任何信息，他需要知道的是「选了这个，这个人就能批准计划、
 *   放宽规则」——授权的后果要在授权的那一刻可见。
 */

const ROLE_POWERS: Record<ProjectRole, string> = {
  sponsor: '确认需求、业务验收',
  tech_lead: '批准计划、放宽规则、强制放行、扩大 Agent 权限',
  pm: '项目设置、收紧规则、调度与成员管理',
  member: '执行任务、接管 Agent、处理决策',
  viewer: '只读，不能做任何改动',
};

export function MembersPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const currentUserId = useAuthStore((s) => s.userId);
  const perms = usePermissions(projectId);
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const members = useQuery({
    queryKey: qk.members(projectId!),
    queryFn: () => api.members(projectId!),
    enabled: Boolean(projectId && currentUserId),
  });

  const orgUsers = useQuery({
    queryKey: ['orgUsers'],
    queryFn: () => api.orgUsers(),
    enabled: adding,
  });

  /**
   * ★ 改完自己的角色必须把权限缓存也作废。
   *
   *   不作废的话，一个刚把自己从 tech_lead 降成 member 的人，
   *   界面上按钮还全亮着 —— 点下去才收到 403。
   *   权限清单和成员表是同一份事实的两个视图，必须一起失效。
   */
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.members(projectId!) });
    void qc.invalidateQueries({ queryKey: qk.permissions(projectId!) });
  };

  const setRole = useMutation({
    mutationFn: (v: { userId: string; role: ProjectRole }) =>
      api.setMemberRole(projectId!, v.userId, v.role),
    onSuccess: () => {
      setError(null);
      setAdding(false);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : '修改角色失败'),
  });

  const remove = useMutation({
    mutationFn: (userId: string) => api.removeMember(projectId!, userId),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : '移除成员失败'),
  });

  if (!projectId) return null;

  const data = members.data;
  const humans = data?.members.filter((m) => m.actorType === 'human') ?? [];
  const agentMembers = data?.members.filter((m) => m.actorType === 'agent') ?? [];
  const memberIds = new Set(humans.map((m) => m.actorId));
  const canManage = perms.can('project.members.manage');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">成员与角色</h1>
          <RoleBadge projectId={projectId} />
          <Link
            to={`/projects/${projectId}`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            ← 回到项目
          </Link>
          <GatedButton
            permission="project.members.manage"
            projectId={projectId}
            onClick={() => setAdding(true)}
            className="ml-auto rounded bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-700"
          >
            添加成员
          </GatedButton>
        </div>
        <p className="mt-0.5 text-[11px] text-slate-400">
          角色决定这个人在本项目里能做什么。权限变更全部记入审计
        </p>
      </div>

      {members.isPending && <div className="p-4"><CardSkeleton /></div>}
      {members.isError && (
        <div className="p-4">
          <ErrorState error={members.error} onRetry={() => void members.refetch()} />
        </div>
      )}

      {data && (
        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-3">
          <div className="mx-auto max-w-3xl space-y-3">
            {error && (
              <p className="rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800">
                {error}
                <button type="button" className="ml-2 underline" onClick={() => setError(null)}>
                  知道了
                </button>
              </p>
            )}

            {adding && (
              <section className="rounded border border-slate-300 bg-white px-3 py-2">
                <h2 className="text-xs font-medium text-slate-700">添加成员</h2>
                <p className="text-[11px] text-slate-400">只能添加本组织的人</p>
                <ul className="mt-1.5 max-h-64 space-y-1 overflow-y-auto">
                  {orgUsers.data?.users
                    .filter((u) => !memberIds.has(u.id))
                    .map((u) => (
                      <li key={u.id} className="flex items-center gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate text-slate-800">
                          {u.name}
                          <span className="ml-1 text-[11px] text-slate-400">{u.email}</span>
                        </span>
                        <select
                          defaultValue="member"
                          onChange={(e) =>
                            setRole.mutate({ userId: u.id, role: e.target.value as ProjectRole })
                          }
                          className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px]"
                          aria-label={`${u.name} 的角色`}
                        >
                          <option value="">选择角色…</option>
                          {data.assignableRoles.map((r) => (
                            <option key={r.role} value={r.role}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      </li>
                    ))}
                  {orgUsers.isPending && <li className="text-xs text-slate-400">加载中…</li>}
                  {orgUsers.data?.users.filter((u) => !memberIds.has(u.id)).length === 0 && (
                    <li className="text-xs text-slate-400">组织里的人都已经是本项目成员了</li>
                  )}
                </ul>
                <button
                  type="button"
                  onClick={() => setAdding(false)}
                  className="mt-1.5 text-[11px] text-slate-500 underline"
                >
                  收起
                </button>
              </section>
            )}

            <section className="rounded border border-slate-200 bg-white">
              <h2 className="border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">
                人类成员（{humans.length}）
              </h2>
              <ul>
                {humans.map((m) => (
                  <li
                    key={m.actorId}
                    className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs last:border-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-slate-900">
                        {m.name ?? m.actorId}
                        {m.actorId === currentUserId && (
                          <span className="ml-1 text-[11px] text-slate-400">（你）</span>
                        )}
                      </p>
                      <p className="truncate text-[11px] text-slate-400">
                        {m.email} · 加入于 {relativeTime(m.addedAt)}
                      </p>
                    </div>

                    {/*
                      ★ 角色旁边写它能做什么。「tech_lead」对业务负责人不构成信息，
                        「批准计划、放宽规则」才是他要判断的东西。
                    */}
                    <select
                      value={m.role}
                      disabled={!canManage}
                      title={canManage ? ROLE_POWERS[m.role as ProjectRole] : perms.why('project.members.manage')}
                      onChange={(e) =>
                        setRole.mutate({ userId: m.actorId, role: e.target.value as ProjectRole })
                      }
                      className={clsx(
                        'rounded border border-slate-300 px-1.5 py-0.5 text-[11px]',
                        !canManage && 'cursor-not-allowed opacity-60',
                      )}
                      aria-label={`${m.name ?? m.actorId} 的角色`}
                    >
                      {data.assignableRoles.map((r) => (
                        <option key={r.role} value={r.role}>
                          {r.label}
                        </option>
                      ))}
                    </select>

                    <span className="hidden w-56 shrink-0 text-[11px] text-slate-400 md:block">
                      {ROLE_POWERS[m.role as ProjectRole] ?? ''}
                    </span>

                    <GatedButton
                      permission="project.members.manage"
                      projectId={projectId}
                      onClick={() => remove.mutate(m.actorId)}
                      className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
                    >
                      移除
                    </GatedButton>
                  </li>
                ))}
              </ul>
            </section>

            {agentMembers.length > 0 && (
              <section className="rounded border border-slate-200 bg-white">
                <h2 className="border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">
                  Agent 成员（{agentMembers.length}）
                </h2>
                {/*
                  ★ Agent 与人类同表，但角色语义完全不同：
                    人类的角色是权限，Agent 的角色是「它在本项目里干什么」。
                    Agent 的权限独立配置在 Agent 档案里，绝不继承人类（§1.2）——
                    所以这里只列出来，不给改角色的下拉框。
                */}
                <ul>
                  {agentMembers.map((m) => (
                    <li
                      key={m.actorId}
                      className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs last:border-0"
                    >
                      <span className="min-w-0 flex-1 truncate text-slate-800">
                        🤖 {m.name ?? m.actorId}
                      </span>
                      <span className="text-[11px] text-slate-400">{m.role}</span>
                    </li>
                  ))}
                </ul>
                <p className="px-3 pb-2 text-[11px] text-slate-400">
                  Agent 的权限独立配置，不继承任何人类成员 —— 在 Agent 档案里管理
                </p>
              </section>
            )}

            <p className="text-[11px] text-slate-400">
              角色能做什么见{' '}
              <span className="text-slate-500">docs/tech/09-security.md §2.3 权限矩阵</span>
              。收紧权限总是比放宽容易：例如收紧规则 pm 就可以，放宽必须 tech_lead
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
