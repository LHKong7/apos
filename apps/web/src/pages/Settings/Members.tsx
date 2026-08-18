import { useT } from '../../lib/i18n';
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
import type { AssignableRole } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * 项目成员与角色（docs/tech/09-security.md §2.2）。
 *
 * ★★ 这一页是整套 RBAC 能不能落地的关键，而不是一个管理附属品。
 *
 *   一套改不了的权限体系，实践中的结局永远是「所有人共用一个账号」——
 *   因为换角色比换个人麻烦。权限模型的落地程度，取决于调整它有多容易。
 *
 * ★★ 人和 Agent 在同一张表里，担任同一套角色。
 *
 *   这是这个产品的形状：「测试」这个岗位上可能坐着一个人，
 *   也可能是 test-agent-1，还可能两者都有。分成两个页面的话，
 *   「这个项目谁在干活」就再也没有一个能一眼看全的地方了。
 *
 * ★ 角色列表来自服务端（含超管自定义的研发 / 运营 / 测试），
 *   不是前端硬编码的枚举。
 */
export function MembersPage() {
  const t = useT();
  const { projectId } = useParams<{ projectId: string }>();
  const currentUserId = useAuthStore((s) => s.userId);
  const perms = usePermissions(projectId);
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<'human' | 'agent' | null>(null);

  const members = useQuery({
    queryKey: qk.members(projectId!),
    queryFn: () => api.members(projectId!),
    enabled: Boolean(projectId && currentUserId),
  });

  const directory = useQuery({
    queryKey: ['orgDirectory'],
    queryFn: () => api.orgUsers(),
    enabled: adding !== null,
  });

  /**
   * ★ 改完角色必须把权限缓存也作废。
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
    mutationFn: (v: { id: string; role: string | null; actorType: 'human' | 'agent' }) =>
      api.setMemberRole(projectId!, v.id, v.role, v.actorType),
    onSuccess: () => {
      setError(null);
      setAdding(null);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('members.roleChangeFailed')),
  });

  const remove = useMutation({
    mutationFn: (v: { id: string; actorType: 'human' | 'agent' }) =>
      api.removeMember(projectId!, v.id, v.actorType),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('members.removeFailed')),
  });

  if (!projectId) return null;

  const data = members.data;
  const humans = data?.members.filter((m) => m.actorType === 'human') ?? [];
  const agentMembers = data?.members.filter((m) => m.actorType === 'agent') ?? [];
  const memberIds = new Set(data?.members.map((m) => m.actorId) ?? []);
  const canManage = perms.can('project.members.manage');

  /** 人的下拉框和 Agent 的下拉框内容不同 —— 带 Human Gate 权限的角色给不了 Agent */
  const rolesFor = (actorType: 'human' | 'agent'): AssignableRole[] =>
    (data?.assignableRoles ?? []).filter((r) => r.appliesTo.includes(actorType));

  const candidates =
    adding === 'agent'
      ? (directory.data?.agents ?? [])
          .filter((a) => !memberIds.has(a.id))
          .map((a) => ({ id: a.id, name: a.name, sub: `${a.type} · ${a.status}` }))
      : (directory.data?.users ?? [])
          .filter((u) => !memberIds.has(u.id))
          .map((u) => ({ id: u.id, name: u.name, sub: u.email }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">{t('members.title')}</h1>
          <RoleBadge projectId={projectId} />
          <Link
            to={`/projects/${projectId}`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            {t('nav.backToProject')}
          </Link>
          <Link
            to={`/projects/${projectId}/settings/roles`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            {t('members.toRoles')}
          </Link>
          {/*
            ★ 通向「开账号」的入口必须在这里。
              候选人名单空着的时候，管理员在这一页找不到任何出路 ——
              账号是组织级的，而这一页是项目级的，两者的关系不写出来就得靠猜。
          */}
          <Link
            to={`/projects/${projectId}/settings/accounts`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            {t('members.toAccounts')}
          </Link>
          <div className="ml-auto flex gap-1.5">
            <GatedButton
              permission="project.members.manage"
              projectId={projectId}
              onClick={() => setAdding('human')}
              className="rounded bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-700"
            >
              {t('members.addMember')}
            </GatedButton>
            <GatedButton
              permission="project.members.manage"
              projectId={projectId}
              onClick={() => setAdding('agent')}
              className="rounded border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
            >
              {t('members.addAgent')}
            </GatedButton>
          </div>
        </div>
        <p className="mt-0.5 text-[11px] text-slate-400">
          {t('members.roleHint')}
        </p>
      </div>

      {members.isPending && (
        <div className="p-4">
          <CardSkeleton />
        </div>
      )}
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
                <Button variant="ghost" className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent ml-2 underline" onClick={() => setError(null)}>
                  {t('common.gotIt')}
                </Button>
              </p>
            )}

            {adding && (
              <section className="rounded border border-slate-300 bg-white px-3 py-2">
                <h2 className="text-xs font-medium text-slate-700">
                  {adding === 'agent' ? t('members.addAgent') : t('members.addMember')}
                </h2>
                <p className="text-[11px] text-slate-400">
                  {adding === 'agent'
                    ? t('members.agentDropdownHint')
                    : t('members.orgOnly')}
                </p>
                <ul className="mt-1.5 max-h-64 space-y-1 overflow-y-auto">
                  {candidates.map((c) => (
                    <li key={c.id} className="flex items-center gap-2 text-xs">
                      <span className="min-w-0 flex-1 truncate text-slate-800">
                        {adding === 'agent' && <span className="mr-1">🤖</span>}
                        {c.name}
                        <span className="ml-1 text-[11px] text-slate-400">{c.sub}</span>
                      </span>
                      {/*
                        ★★ Agent 一键加入，人必须先挑角色。

                          不对称是有意的：Agent 只有 executor 这一个「干活」档
                          （其余带 humanOnly 权限的角色它担任不了），默认值不含
                          任何判断；而人的角色从业务负责人到只读都有，
                          替他默认任何一档都是在替他做一次授权决定。

                          下拉框对 Agent 仍然留着 —— 它是**覆盖**，不是前置条件。
                      */}
                      {adding === 'agent' && (
                        <Button variant="ghost"
                          disabled={setRole.isPending}
                          onClick={() => setRole.mutate({ id: c.id, role: null, actorType: 'agent' })}
                          className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent shrink-0 rounded border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {t('members.addAsExecutor')}
                        </Button>
                      )}
                      {/*
                        ★ 这个下拉是「挑一个角色把人加进来」，不是在显示当前值 ——
                          原来靠 defaultValue="" 保持在占位项上。Radix 没有
                          defaultValue 空串这一招（空串是它的「未选中」），
                          所以改成受控地钉在 undefined：选完就发请求，
                          列表随之刷新，这一项本来也不该留下选中痕迹。

                          This picker chooses a role to add someone with; it never
                          displays a current value. Radix reserves the empty
                          string, so instead of defaultValue="" it stays
                          value={undefined} and fires on pick.
                      */}
                      <Select
                        value={undefined}
                        onValueChange={(v) =>
                          v && setRole.mutate({ id: c.id, role: v, actorType: adding })
                        }
                      >
                        <SelectTrigger
                          className="h-auto w-auto px-1.5 py-0.5 text-[11px]"
                          aria-label={t('members.roleOf', { name: c.name })}
                        >
                          <SelectValue
                            placeholder={
                              adding === 'agent'
                                ? t('members.orChooseRole')
                                : t('members.chooseRole')
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {rolesFor(adding).map((r) => (
                            <SelectItem key={r.role} value={r.role}>
                              {r.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </li>
                  ))}
                  {directory.isPending && <li className="text-xs text-slate-400">{t('common.loading')}</li>}
                  {!directory.isPending && candidates.length === 0 && (
                    <li className="text-xs text-slate-400">
                      {adding === 'agent'
                        ? t('members.allAgentsAdded')
                        : t('members.allPeopleAdded')}
                    </li>
                  )}
                </ul>
                <Button variant="ghost"
                  onClick={() => setAdding(null)}
                  className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent mt-1.5 text-[11px] text-slate-500 underline"
                >
                  {t('members.collapse')}
                </Button>
              </section>
            )}

            <MemberTable
              title={t('members.humans', { count: humans.length })}
              rows={humans}
              roles={rolesFor('human')}
              canManage={canManage}
              denyReason={perms.why('project.members.manage')}
              currentUserId={currentUserId}
              onChange={(id, role) => setRole.mutate({ id, role, actorType: 'human' })}
              onRemove={(id) => remove.mutate({ id, actorType: 'human' })}
            />

            {/*
              ★★ Agent 与人同表同角色，但一定要**分组显示**。
                混在一列里，「这个项目有几个真人」这个问题就答不上来了 ——
                而那恰恰是看混合团队时第一个要问的。
            */}
            <MemberTable
              title={t('members.agents', { count: agentMembers.length })}
              hint={t('members.agentRoleNote')}
              rows={agentMembers}
              roles={rolesFor('agent')}
              canManage={canManage}
              denyReason={perms.why('project.members.manage')}
              currentUserId={null}
              icon="🤖"
              empty={t('members.noAgents')}
              onChange={(id, role) => setRole.mutate({ id, role, actorType: 'agent' })}
              onRemove={(id) => remove.mutate({ id, actorType: 'agent' })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

interface Row {
  actorId: string;
  role: string;
  roleLabel: string;
  permissionCount: number;
  addedAt: string;
  name: string | null;
  email: string | null;
  detail: string | null;
}

function MemberTable({
  title,
  hint,
  rows,
  roles,
  canManage,
  denyReason,
  currentUserId,
  icon,
  empty,
  onChange,
  onRemove,
}: {
  title: string;
  hint?: string;
  rows: Row[];
  roles: AssignableRole[];
  canManage: boolean;
  denyReason: string | undefined;
  currentUserId: string | null;
  icon?: string;
  empty?: string;
  onChange: (id: string, role: string) => void;
  onRemove: (id: string) => void;
}) {
  const t = useT();
  return (
    <section className="rounded border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-3 py-1.5">
        <h2 className="text-xs font-medium text-slate-700">{title}</h2>
        {hint && <p className="text-[11px] text-slate-400">{hint}</p>}
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-3 text-center text-xs text-slate-400">{empty ?? t('members.empty')}</p>
      ) : (
        <ul>
          {rows.map((m) => {
            const role = roles.find((r) => r.role === m.role);
            return (
              <li
                key={m.actorId}
                className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-slate-900">
                    {icon && <span className="mr-1">{icon}</span>}
                    {m.name ?? m.actorId}
                    {m.actorId === currentUserId && (
                      <span className="ml-1 text-[11px] text-slate-400">{t('members.you')}</span>
                    )}
                  </p>
                  <p className="truncate text-[11px] text-slate-400">
                    {t('members.joinedAt', {
                      detail: m.email ?? m.detail ?? '',
                      time: relativeTime(m.addedAt),
                    })}
                  </p>
                </div>

                {/*
                  ★ 角色旁边写它能做什么。「tech_lead」对业务负责人不构成信息，
                    「批准计划、放宽规则」才是他要判断的东西 —— 授权的后果
                    要在授权的那一刻可见。
                */}
                <Select
                  value={m.role}
                  disabled={!canManage}
                  onValueChange={(v) => onChange(m.actorId, v)}
                >
                  <SelectTrigger
                    className={clsx(
                      'h-auto w-auto px-1.5 py-0.5 text-[11px]',
                      !canManage && 'cursor-not-allowed opacity-60',
                    )}
                    title={canManage ? role?.description : denyReason}
                    aria-label={t('members.roleOf', { name: m.name ?? m.actorId })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/*
                      当前角色可能已不适用于这一类担任者（角色被改窄了），仍要显示出来。
                      ★ 多一道 `m.role &&`：原生 select 对 value="" 无所谓，
                        Radix 会**抛错**（空串是它的「未选中」保留值）——
                        一条角色为空的成员记录会让整页白屏，而不是少一个选项。
                    */}
                    {m.role && !roles.some((r) => r.role === m.role) && (
                      <SelectItem value={m.role}>
                        {t('members.roleNoLongerApplies', { label: m.roleLabel })}
                      </SelectItem>
                    )}
                    {roles.map((r) => (
                      <SelectItem key={r.role} value={r.role}>
                        {r.label}
                        {r.builtin ? '' : t('members.customRole')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <span className="hidden w-52 shrink-0 truncate text-[11px] text-slate-400 md:block">
                  {role?.description ?? t('members.permissionCount', { count: m.permissionCount })}
                </span>

                <GatedButton
                  permission="project.members.manage"
                  onClick={() => onRemove(m.actorId)}
                  className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
                >
                  {t('members.remove')}
                </GatedButton>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
