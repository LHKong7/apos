import { useT, type MessageKey } from '../../lib/i18n';
import { joinList, colon } from '@/lib/format';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { CardSkeleton, ErrorState } from '../../components/states';
import { GatedButton } from '../../components/Gated';
import { usePermissions } from '../../lib/permissions/usePermissions';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import type { AvailablePermission, Permission, RoleRow } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { qk } from '../../lib/query/keys';
import { useOrgStore } from '../../stores/org';
import { Label } from '@/components/ui/label';
import { WhatIsThis } from './primitives';

/**
 * Role definitions (docs/tech/09-security.md §2.2) / 角色定义。
 *
 * ★★ This is where an owner invents "engineering", "operations", "QA". The six
 *   built-in roles cover **how a project runs**; they cannot cover **how this
 *   organization divides its work** — every company cuts that differently.
 *
 * ★★ Every role has to answer one question: **who holds it, a human or an agent?**
 *
 *   That is the basic shape of a Human–Agent team, and the answer is not free-form: a
 *   role carrying permissions like confirm-requirement / approve-plan / handle-decision
 *   can never be given to an agent — those few permissions are the entirety of where
 *   "humans always keep final decision authority" actually lands. The UI marks such
 *   permissions inline and locks the agent option the moment one is checked, rather
 *   than letting the server reject the submission afterward.
 *
 * ★★ 超管在这里造出「研发」「运营」「测试」。每个角色都要回答「谁来担任，
 *   人还是 Agent」：带「确认需求 / 批准计划 / 处理决策」这类权限的角色永远不能
 *   给 Agent，界面上勾了就当场锁掉，而不是等提交后被服务端驳回。
 */

/** Permission prefix → message key. Module-level constants store keys, not translations */
const GROUP_KEYS: Record<string, MessageKey> = {
  project: 'roles.group.project',
  requirement: 'roles.group.requirement',
  clarification: 'roles.group.requirement',
  plan: 'roles.group.plan',
  work_item: 'roles.group.workItem',
  decision: 'roles.group.decision',
  policy: 'roles.group.policy',
  convention: 'roles.group.convention',
  integration: 'roles.group.integration',
};

/** These prefixes read the same in both languages, so they get no catalog entry */
const GROUP_LITERALS: Record<string, string> = { run: 'Agent Run', agent: 'Agent' };

function groupLabel(prefix: string, tr: (k: MessageKey) => string): string {
  const key = GROUP_KEYS[prefix];
  return key ? tr(key) : (GROUP_LITERALS[prefix] ?? prefix);
}

interface Draft {
  key: string;
  name: string;
  description: string;
  permissions: Set<Permission>;
  agents: boolean;
  builtin: boolean;
  /**
   * Which role this one was copied from / 复制自哪个角色。
   *
   * ★★ **A provenance label, not an inheritance link.** Made dynamic, any later tweak
   *   the platform makes to a built-in role would propagate into every derived role —
   *   which is exactly how permission creep happens. What is copied is the permission
   *   snapshot as of that moment; afterward the two have nothing to do with each other.
   */
  basedOn?: { key: string; name: string } | null;
}

const emptyDraft = (): Draft => ({
  key: '',
  name: '',
  description: '',
  permissions: new Set<Permission>(['project.view']),
  agents: false,
  builtin: false,
});

export function RolesPage() {
  const t = useT();
  const { projectId } = useParams<{ projectId: string }>();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const perms = usePermissions(projectId);
  /**
   * ★ Reading roles is unguarded (the members page needs them to render its dropdown);
   *   only writing requires org.roles.manage. But the buttons must gray out on the
   *   write permission — let someone fill in a whole form and then hit a 403 and they
   *   will not understand why it was refused, they will conclude the feature is broken.
   */
  const canManage = perms.can('org.roles.manage');
  /** ★ Roles are org-scoped — the cache key must carry the org, or switching orgs first
   *  shows the previous org's roles */
  const orgId = useOrgStore((s) => s.orgId);

  const roles = useQuery({ queryKey: qk.roles(orgId), queryFn: () => api.roles() });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.roles(orgId) });
    // A role's permissions changed, so everyone's permission list changes with it
    void qc.invalidateQueries({ queryKey: ['permissions'] });
    void qc.invalidateQueries({ queryKey: ['members'] });
  };

  const save = useMutation({
    mutationFn: (d: Draft) => {
      const body = {
        name: d.name,
        description: d.description,
        permissions: [...d.permissions],
        appliesTo: (d.agents ? ['human', 'agent'] : ['human']) as ('human' | 'agent')[],
      };
      if (editingKey) return api.updateRole(editingKey, body);
      /**
       * ★ Copying from a template goes through the clone endpoint: it records "modeled
       *   on which role" in the audit trail. Via createRole, a new role identical to
       *   tech_lead simply appears in the audit log with nothing saying where it came
       *   from.
       */
      if (d.basedOn) {
        return api.cloneRole(d.basedOn.key, {
          key: d.key,
          name: d.name,
          description: d.description,
        });
      }
      return api.createRole({ ...body, key: d.key });
    },
    onSuccess: () => {
      setEditing(null);
      setEditingKey(null);
      setError(null);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('roles.saveFailed')),
  });

  const remove = useMutation({
    mutationFn: (key: string) => api.deleteRole(key),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('roles.deleteFailed')),
  });

  /**
   * "Copy and edit" / 「复制并改」。
   *
   * ★★ It is the other half of built-in roles being immutable. Say only "you cannot
   *   change it" and the user's next move is to tick 48 permissions from scratch — and
   *   what they build almost certainly differs from the "same as tech_lead but one
   *   fewer" they wanted, in ways they cannot themselves name.
   *
   * ★ The client only **prefills** the source role's permissions into the draft; the
   *   real copy happens on the server (cloneRole), because "modeled on which role"
   *   belongs in the audit trail.
   */
  const openClone = (r: RoleRow) => {
    setEditingKey(null);
    setEditing({
      key: '',
      name: t('roles.copyOf', { name: r.name }),
      description: r.description,
      permissions: new Set(r.permissions),
      agents: r.appliesTo.includes('agent'),
      builtin: false,
      basedOn: { key: r.key, name: r.name },
    });
  };

  const openEdit = (r: RoleRow) => {
    setEditingKey(r.key);
    setEditing({
      key: r.key,
      name: r.name,
      description: r.description,
      permissions: new Set(r.permissions),
      agents: r.appliesTo.includes('agent'),
      builtin: r.builtin,
    });
  };

  const data = roles.data;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">{t('roles.title')}</h1>
          {projectId && (
            <Link
              to={`/projects/${projectId}/settings/members`}
              className="text-xs text-slate-500 hover:text-slate-700"
            >
              {t('accounts.backToMembers')}
            </Link>
          )}
          <GatedButton
            permission="org.roles.manage"
            projectId={projectId}
            onClick={() => {
              setEditingKey(null);
              setEditing(emptyDraft());
            }}
            className="ml-auto rounded bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-700"
          >
            {t('roles.new')}
          </GatedButton>
        </div>
        <p className="mt-0.5 text-[11px] text-slate-400">
          {t('roles.hint')}
        </p>
      </div>

      {roles.isPending && (
        <div className="p-4">
          <CardSkeleton />
        </div>
      )}
      {roles.isError && (
        <div className="p-4">
          <ErrorState error={roles.error} onRetry={() => void roles.refetch()} />
        </div>
      )}

      {data && (
        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-3">
          <div className="mx-auto max-w-3xl space-y-3">
            {/*
              ★ This page speaks in domain vocabulary (Policy / roles / integrations /
                members and grants). Precise to whoever wrote it, a wall to a project
                manager. The opening line answers "does this concern me at all" first
                (issue log #42).
            */}
            <WhatIsThis storageKey="roles" title={t('whatIs.roles.title')}>
              <p>{t('whatIs.roles.p1')}</p>
              <p>{t('whatIs.roles.p2')}</p>
              <p>{t('whatIs.roles.p3')}</p>
            </WhatIsThis>
            {error && (
              <p className="rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800">
                {error}
                <Button variant="ghost" className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent ml-2 underline" onClick={() => setError(null)}>
                  {t('common.gotIt')}
                </Button>
              </p>
            )}

            <RoleSection
              title={t('roles.builtin')}
              hint={t('roles.builtinHint')}
              roles={data.roles.filter((r) => r.builtin)}
              canManage={canManage}
              onEdit={openEdit}
              onClone={openClone}
              onDelete={(k) => remove.mutate(k)}
            />

            <RoleSection
              title={t('roles.custom')}
              hint={t('roles.customHint')}
              roles={data.roles.filter((r) => !r.builtin)}
              canManage={canManage}
              onEdit={openEdit}
              onClone={openClone}
              onDelete={(k) => remove.mutate(k)}
              empty={t('roles.customEmpty')}
            />
          </div>
        </div>
      )}

      {editing && data && (
        // ★ Width belongs to Modal: a w-[560px] set on the inner element exceeds the
        //   dialog's own max-w-md, so it overflows horizontally while the caller sees
        //   only "I set a width and nothing got wider".
        <Modal onClose={() => setEditing(null)} title={t('roles.editor')} width="lg">
          <RoleEditor
            draft={editing}
            isNew={editingKey === null}
            roles={data.roles}
            available={data.availablePermissions}
            readOnly={!canManage}
            pending={save.isPending}
            onChange={setEditing}
            onCancel={() => setEditing(null)}
            onSave={() => save.mutate(editing)}
          />
        </Modal>
      )}
    </div>
  );
}

function RoleSection({
  title,
  hint,
  roles,
  empty,
  canManage,
  onEdit,
  onClone,
  onDelete,
}: {
  title: string;
  hint: string;
  roles: RoleRow[];
  empty?: string;
  canManage: boolean;
  onEdit: (r: RoleRow) => void;
  onClone: (r: RoleRow) => void;
  onDelete: (key: string) => void;
}) {
  const t = useT();
  return (
    <section className="rounded border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-3 py-1.5">
        <h2 className="text-xs font-medium text-slate-700">
          {title}（{roles.length}）
        </h2>
        <p className="text-[11px] text-slate-400">{hint}</p>
      </div>
      {roles.length === 0 ? (
        <p className="px-3 py-3 text-center text-xs text-slate-400">{empty ?? t('roles.empty')}</p>
      ) : (
        <ul>
          {roles.map((r) => (
            <li key={r.key} className="border-b border-slate-100 px-3 py-2 last:border-0">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-slate-900">{r.name}</span>
                <code className="text-[11px] text-slate-400">{r.key}</code>
                {/*
                  ★ "Who can hold it" is the most important thing on this row, so it goes
                    where the eye lands first. A role list that shows a permission count
                    and no holder cannot answer "is our QA seat a human or an agent right
                    now".
                */}
                <span
                  className={clsx(
                    'rounded px-1.5 py-0.5 text-[11px]',
                    r.appliesTo.includes('agent')
                      ? 'bg-sky-50 text-sky-800'
                      : 'bg-slate-100 text-slate-600',
                  )}
                >
                  {r.appliesTo.includes('agent') ? t('roles.holderBoth') : t('roles.holderHumanOnly')}
                </span>
                <span className="text-[11px] text-slate-400">{t('roles.permissionCount', { count: r.permissions.length })}</span>
                <span className="text-[11px] text-slate-400">
                  {t('roles.humanCount', { count: r.memberCount.human })}
                  {r.memberCount.agent > 0 && t('roles.agentCount', { count: r.memberCount.agent })}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-slate-500">{r.description}</p>

              <div className="mt-1 flex gap-1.5 text-[11px]">
                {/* Anyone may view permissions — this is where "why can't I do that" is answered */}
                <Button variant="outline"
                  onClick={() => onEdit(r)}>
                  {r.builtin || !canManage ? t('roles.view') : t('common.edit')}
                </Button>
                {/*
                  ★ "Copy and edit" matters most for built-in roles: their permissions
                    cannot be changed, and this button puts the answer to "so what do I do
                    instead" on the very same row.
                */}
                <GatedButton
                  permission="org.roles.manage"
                  onClick={() => onClone(r)}
                  className="rounded border border-slate-300 px-1.5 py-0.5 text-slate-600 hover:bg-slate-50"
                >
                  {t('roles.clone')}
                </GatedButton>
                {!r.builtin && (
                  <GatedButton
                    permission="org.roles.manage"
                    onClick={() => onDelete(r.key)}
                    className="rounded border border-slate-300 px-1.5 py-0.5 text-slate-600 hover:bg-slate-50"
                  >
                    {t('common.delete')}
                  </GatedButton>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RoleEditor({
  draft,
  isNew,
  roles,
  available,
  readOnly,
  pending,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  isNew: boolean;
  /** Used to compute the diff: which template it was copied from, or what it looked like before */
  roles: RoleRow[];
  available: AvailablePermission[];
  /** Built-in role, or the caller lacks org.roles.manage — the form becomes a readable spec sheet */
  readOnly: boolean;
  pending: boolean;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const t = useT();
  /**
   * ★ Group by the **raw prefix** and translate only at render time. Keying the map by
   *   translated text would reorder the groups when the locale changes — and could even
   *   merge two prefixes that translate to the same word, which is not the intent.
   *
   * ★ 按原始前缀分组，渲染时才译；用译文当 map 的键会让切语言时分组重排甚至合并。
   */
  const groups = useMemo(() => {
    const map = new Map<string, AvailablePermission[]>();
    for (const p of available) {
      map.set(p.group, [...(map.get(p.group) ?? []), p]);
    }
    return [...map.entries()];
  }, [available]);

  /**
   * ★★ Checking a Human Gate permission locks the agent option, and names which
   *   permissions did it.
   *
   *   The server refuses these too, of course (validateRoleDefinition in roles.ts), but
   *   making someone fill in an entire form only to be rejected is a poor experience —
   *   and worse, they will not understand why it was refused and will conclude the
   *   feature is buggy. This lays the cause and effect out on the spot.
   */
  const blocking = [...draft.permissions].filter(
    (p) => available.find((a) => a.key === p)?.humanOnly,
  );
  const agentAllowed = blocking.length === 0;

  /** For a built-in role (or without write permission) the form is read-only — a readable spec sheet */
  const locked = readOnly || (!isNew && draft.builtin);

  const toggle = (p: Permission) => {
    if (locked) return;
    const next = new Set(draft.permissions);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    onChange({ ...draft, permissions: next });
  };

  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-900">
        {isNew ? t('roles.new') : `${locked ? '' : t('common.edit')}「${draft.name}」`}
      </h2>
      {locked && (
        <p className="mt-0.5 text-[11px] text-slate-500">
          {draft.builtin
            ? t('roles.builtinReadOnly')
            : t('roles.readOnlyHint')}
        </p>
      )}

      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <Label className="flex flex-col gap-1">
          <span className="text-slate-600">{t('roles.displayName')}</span>
          <Input
            value={draft.name}
            disabled={locked}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            placeholder={t('roles.displayNamePlaceholder')}
            className="disabled:bg-slate-50 disabled:text-slate-500" />
        </Label>
        <Label className="flex flex-col gap-1">
          <span className="text-slate-600">
            {t('roles.key')}
            <span className="ml-1 text-[11px] text-slate-400">{t('roles.referencedByPolicy')}</span>
          </span>
          <Input
            value={draft.key}
            disabled={!isNew || locked}
            onChange={(e) => onChange({ ...draft, key: e.target.value })}
            placeholder="dev"
            className="disabled:bg-slate-50 disabled:text-slate-400" />
        </Label>
      </div>

      <Label className="mt-2 flex flex-col gap-1 text-xs">
        <span className="text-slate-600">{t('roles.whatFor')}</span>
        <Input
          value={draft.description}
          disabled={locked}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
          placeholder={t('roles.whatForPlaceholder')}
          className="disabled:bg-slate-50 disabled:text-slate-500" />
      </Label>

      {/* ── Who holds it ── */}
      <div className="mt-3 rounded border border-slate-200 bg-slate-50 px-3 py-2">
        <p className="text-xs font-medium text-slate-700">{t('roles.whoHolds')}</p>
        <Label className="mt-1 flex items-start gap-2 text-xs">
          <Checkbox
            checked={draft.agents && agentAllowed}
            disabled={!agentAllowed || locked}
            onCheckedChange={(v) => onChange({ ...draft, agents: v })}
            className="mt-0.5"
          />
          <span className={clsx(!agentAllowed && 'text-slate-400')}>
            {t('roles.allowAgents')}
            <span className="ml-1 text-[11px] text-slate-400">{t('roles.humansAlways')}</span>
          </span>
        </Label>
        {!agentAllowed && (
          <p className="mt-1 text-[11px] text-amber-800">
            {t('roles.humanOnlyBlocking', {
              permissions: joinList(
                blocking.map((p) => available.find((a) => a.key === p)?.label ?? p),
              ),
            })}
          </p>
        )}
      </div>

      {/*
        ── Diff and impact ──

        ★★ By default the editor shows a **diff**, not a checklist of 48 permissions.
          "Two more and one fewer than project member" is the shape already in the
          user's head; a full table makes them compare it twice by hand, and a botched
          comparison produces no warning at all.

        ★★ "How many people this affects" must be stated **before** saving. Roles are
          org-scoped, so one edit can change what a dozen people across five projects
          are allowed to do — and after saving, no screen anywhere tells them that.
      */}
      <RoleDiff draft={draft} roles={roles} available={available} />

      {/* ── Permissions ── */}
      <div className="mt-3">
        <p className="text-xs font-medium text-slate-700">
          {t('roles.permissionsSelected', { count: draft.permissions.size })}
        </p>
        <p className="text-[11px] text-slate-400">
          {t('roles.orgPermissionsNote')}
        </p>
        <div className="mt-1.5 space-y-2">
          {groups.map(([group, items]) => (
            <fieldset key={group} className="rounded border border-slate-200 px-2 py-1.5">
              <legend className="px-1 text-[11px] text-slate-500">{groupLabel(group, t)}</legend>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                {items.map((p) => (
                  <Label key={p.key} className="flex items-start gap-1.5 text-[11px]">
                    <Checkbox
                      checked={draft.permissions.has(p.key)}
                      disabled={locked}
                      onCheckedChange={() => toggle(p.key)}
                      className="mt-0.5"
                    />
                    <span className="text-slate-700">
                      {p.label}
                      {p.humanOnly && (
                        <span
                          className="ml-1 text-amber-700"
                          title={t('roles.humanOnlyHint')}
                        >
                          {t('roles.humanOnlyTag')}
                        </span>
                      )}
                    </span>
                  </Label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-xs text-slate-500">
          {locked ? t('roles.close') : t('common.cancel')}
        </Button>
        {!locked && (
          <Button variant="neutral" size="sm"
            onClick={onSave}
            disabled={pending || !draft.name || (isNew && !draft.key)}>
            {pending ? t('common.saving') : t('common.save')}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The diff against the template (or against the pre-edit state), plus the pre-save
 * impact / 与模板（或改动前）的差异，外加保存前的影响。
 *
 * ★ The diff is computed on the client, the impact is asked of the server.
 *
 *   A diff is pure set arithmetic, so the two sides cannot disagree about it; but "how
 *   many people and agents this affects" requires the membership tables and the client
 *   cannot guess it. More importantly, the `humanOnly` incompatibility must come from
 *   the server — that is the check which will actually refuse the save.
 */
function RoleDiff({
  draft,
  roles,
  available,
}: {
  draft: Draft;
  roles: RoleRow[];
  available: AvailablePermission[];
}) {
  const t = useT();

  /** What it compares against: a copy against its template, an edit against its own prior state */
  const baseline = draft.basedOn
    ? roles.find((r) => r.key === draft.basedOn!.key)
    : roles.find((r) => r.key === draft.key);

  const label = (key: string) => available.find((a) => a.key === key)?.label ?? key;

  const preview = useQuery({
    queryKey: ['rolePreview', draft.key, [...draft.permissions].sort().join(','), draft.agents],
    /** ★ Only ask the server when editing an existing role — nobody holds a brand-new role,
   *  so the impact is always 0 */
    enabled: Boolean(baseline) && !draft.basedOn,
    queryFn: () =>
      api.previewRole(draft.key, {
        name: draft.name,
        description: draft.description,
        permissions: [...draft.permissions],
        appliesTo: draft.agents ? ['human', 'agent'] : ['human'],
      }),
  });

  if (!baseline) return null;

  const before = new Set(baseline.permissions);
  const added = [...draft.permissions].filter((p) => !before.has(p));
  const removed = baseline.permissions.filter((p) => !draft.permissions.has(p));
  const impact = preview.data;

  return (
    <div className="mt-3 rounded border border-slate-200 bg-slate-50 px-3 py-2">
      <p className="text-xs font-medium text-slate-700">
        {t('roles.diffTitle', { name: baseline.name })}
      </p>

      {draft.basedOn && (
        <p className="mt-0.5 text-[11px] text-slate-500">
          {t('roles.basedOn', { name: draft.basedOn.name })}
        </p>
      )}

      {added.length === 0 && removed.length === 0 ? (
        <p className="mt-1 text-[11px] text-slate-500">{t('roles.diffSame')}</p>
      ) : (
        <div className="mt-1 space-y-0.5 text-[11px]">
          {added.length > 0 && (
            <p className="text-emerald-800">
              {t('roles.diffAdded')}{colon()}{joinList(added.map(label))}
            </p>
          )}
          {removed.length > 0 && (
            <p className="text-rose-800">
              {t('roles.diffRemoved')}{colon()}{joinList(removed.map(label))}
            </p>
          )}
        </div>
      )}

      {impact && (
        <div className="mt-1.5 border-t border-slate-200 pt-1.5 text-[11px]">
          <p className="text-slate-700">
            {impact.direction === 'loosen'
              ? t('roles.impact.loosen', { count: impact.added.length })
              : impact.direction === 'tighten'
                ? t('roles.impact.tighten', { count: impact.removed.length })
                : t('roles.impact.neutral')}
          </p>
          <p className="text-slate-500">
            {t('roles.impact.affects', {
              humans: impact.affectedHumans,
              agents: impact.affectedAgents,
            })}
          </p>
          {/*
            ★ The check that will actually refuse the save, stated up front.
              Reported only after the save button is pressed, the error has no way back
              to the checkbox the user is staring at.
          */}
          {impact.humanOnlyConflicts.length > 0 && (
            <p className="mt-0.5 text-amber-800">
              {t('roles.impact.humanOnly', {
                permissions: joinList(impact.humanOnlyConflicts.map((c) => c.label)),
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
