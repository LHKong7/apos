import { useT } from '../../lib/i18n';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
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
import { WhatIsThis } from './primitives';

/**
 * Project members and roles (docs/tech/09-security.md §2.2) / 项目成员与角色。
 *
 * ★★ This page decides whether the whole RBAC model survives contact with
 *   reality; it is not an administrative afterthought.
 *
 *   A permission system nobody can adjust always ends the same way in practice:
 *   everyone shares one account, because changing a role is more trouble than
 *   changing who is logged in. How far a permission model actually gets adopted
 *   is a function of how easy it is to adjust.
 *
 * ★★ Humans and Agents live in the same table and hold the same set of roles.
 *
 *   That is the shape of this product: the "QA" seat might hold a person, or
 *   test-agent-1, or both. Split them onto two pages and there is no longer any
 *   single place to answer "who is working on this project".
 *
 * ★ The role list comes from the server (including the custom dev / ops / QA
 *   roles a superadmin defined), not from an enum hardcoded in the frontend.
 *
 *   一套改不了的权限体系，结局永远是「所有人共用一个账号」；人和 Agent 同表
 *   同角色是这个产品的形状；角色列表来自服务端，不是前端硬编码的枚举。
 */
export function MembersPage() {
  const t = useT();
  const { projectId } = useParams<{ projectId: string }>();
  const currentUserId = useAuthStore((s) => s.userId);
  const perms = usePermissions(projectId);
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  /**
   * ★ `?add=agent` opens the "add an Agent" panel directly. The board's "add
   *   refactor-agent to this project" button lands here; if the user then still
   *   had to hunt for the "Add Agent" button, the shortcut would have saved
   *   exactly one navigation and nothing else (issue #12).
   */
  const [params] = useSearchParams();
  const [adding, setAdding] = useState<'human' | 'agent' | null>(
    params.get('add') === 'agent' ? 'agent' : params.get('add') === 'human' ? 'human' : null,
  );

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
   * ★ Changing a role must also invalidate the permission cache.
   *
   *   Without it, someone who just demoted themselves from tech_lead to member
   *   still sees every button lit up — and only finds out by clicking one and
   *   getting a 403. The permission list and the member table are two views of
   *   the same fact, so they have to expire together.
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

  /** The human and Agent pickers differ — a role carrying Human Gate permissions cannot be given to an Agent */
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
            ★ The path to "create an account" has to be right here. When the
              candidate list comes up empty, an admin on this page has no way
              forward — accounts are organization-level while this page is
              project-level, and unless that relationship is spelled out they
              have to guess it.
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
            {/*
              ★ This page speaks domain vocabulary (Policy / roles / integrations
                / members and grants) — precise to whoever wrote it, a wall to a
                project manager. The opening line answers "does this concern me"
                first (issue #42).
            */}
            <WhatIsThis storageKey="members" title={t('whatIs.members.title')}>
              <p>{t('whatIs.members.p1')}</p>
              <p>{t('whatIs.members.p2')}</p>
              <p>{t('whatIs.members.p3')}</p>
            </WhatIsThis>
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
                        ★★ An Agent joins in one click; a human must have a role
                          picked first.

                          The asymmetry is deliberate: an Agent has exactly one
                          "does the work" tier, executor (every other role
                          carries humanOnly permissions it cannot hold), so the
                          default embeds no judgment. Human roles run from
                          business owner down to read-only, and defaulting any
                          of them would be making an authorization decision on
                          that person's behalf.

                          The picker is still there for Agents — it is an
                          **override**, not a precondition.
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
                        ★ This picker chooses a role to add someone with; it never
                          displays a current value. It used to sit on its
                          placeholder via defaultValue="". Radix has no such
                          trick — it reserves the empty string for "nothing
                          selected" — so it is controlled at value={undefined}
                          instead: picking fires the request, the list refreshes,
                          and no selection should linger here anyway.

                          这个下拉是「挑一个角色把人加进来」，不是在显示当前值；
                          Radix 把空串留作「未选中」，所以受控地钉在 undefined。
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
              ★★ Agents and humans share the table and the roles, but they must
                be shown in **separate groups**. Mixed into one list, "how many
                real people are on this project" becomes unanswerable — and that
                is the first question anyone asks about a hybrid team.
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
                  ★ Say next to each role what it can do. "tech_lead" carries no
                    information for a business owner; "approves plans, relaxes
                    rules" is what they actually have to judge — the consequence
                    of a grant has to be visible at the moment of granting.
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
                      The current role may no longer apply to this kind of holder
                      (the role was narrowed); it still has to be shown.
                      ★ The extra `m.role &&`: a native select shrugs at value="",
                        but Radix **throws** (it reserves the empty string for
                        "nothing selected") — so one member row with an empty
                        role blanks the entire page rather than dropping one
                        option.
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
