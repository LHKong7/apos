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
import { Input } from '@/components/ui/input';

/**
 * 角色定义（docs/tech/09-security.md §2.2）。
 *
 * ★★ 超管在这里造出「研发」「运营」「测试」。内置的六个覆盖
 *   「项目怎么运转」，覆盖不了「这个组织怎么分工」—— 每家的切法都不一样。
 *
 * ★★ 每个角色都要回答一个问题：**谁来担任，人还是 Agent？**
 *
 *   这是 Human–Agent 混合团队的基本形状。而答案不是随便选的：
 *   带「确认需求 / 批准计划 / 处理决策」这类权限的角色永远不能给 Agent ——
 *   那几条是「人类始终掌握最终决策权」这句话的全部落点。
 *   界面上直接把这些权限标出来，勾了就自动锁掉 Agent 选项，
 *   而不是等提交后被服务端驳回。
 */

const GROUP_LABELS: Record<string, string> = {
  project: '项目',
  requirement: '需求',
  clarification: '需求',
  plan: '计划',
  work_item: '任务',
  run: 'Agent Run',
  decision: '决策',
  policy: '规则',
  agent: 'Agent',
  convention: '工程约定',
  integration: '集成',
};

interface Draft {
  key: string;
  name: string;
  description: string;
  permissions: Set<Permission>;
  agents: boolean;
  builtin: boolean;
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
  const { projectId } = useParams<{ projectId: string }>();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const perms = usePermissions(projectId);
  /**
   * ★ 读角色不设防（成员页要用它渲染下拉框），写才要 org.roles.manage。
   *   但按钮要按写权限灰掉 —— 让人填完一整个表单再被 403 驳回，
   *   他不会理解「为什么不行」，只会觉得这个功能坏了。
   */
  const canManage = perms.can('org.roles.manage');

  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.roles() });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['roles'] });
    // 角色权限变了，所有人的权限清单跟着变
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
      return editingKey
        ? api.updateRole(editingKey, body)
        : api.createRole({ ...body, key: d.key });
    },
    onSuccess: () => {
      setEditing(null);
      setEditingKey(null);
      setError(null);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : '保存失败'),
  });

  const remove = useMutation({
    mutationFn: (key: string) => api.deleteRole(key),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : '删除失败'),
  });

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
          <h1 className="text-sm font-semibold text-slate-900">角色定义</h1>
          {projectId && (
            <Link
              to={`/projects/${projectId}/settings/members`}
              className="text-xs text-slate-500 hover:text-slate-700"
            >
              ← 成员与角色
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
            新建角色
          </GatedButton>
        </div>
        <p className="mt-0.5 text-[11px] text-slate-400">
          内置角色就是权限矩阵本身，不可修改。组织自己的分工（研发 / 运营 / 测试…）在这里定义
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
            {error && (
              <p className="rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800">
                {error}
                <button type="button" className="ml-2 underline" onClick={() => setError(null)}>
                  知道了
                </button>
              </p>
            )}

            <RoleSection
              title="内置角色"
              hint="权限矩阵本身（09-security §2.3），不可修改也不可删除。要不一样就新建一个"
              roles={data.roles.filter((r) => r.builtin)}
              canManage={canManage}
              onEdit={openEdit}
              onDelete={(k) => remove.mutate(k)}
            />

            <RoleSection
              title="组织自定义角色"
              hint="按你们的分工定义。带 Human Gate 权限的角色不能给 Agent 担任"
              roles={data.roles.filter((r) => !r.builtin)}
              canManage={canManage}
              onEdit={openEdit}
              onDelete={(k) => remove.mutate(k)}
              empty="还没有自定义角色。「研发」「运营」「测试」这类岗位在这里定义"
            />
          </div>
        </div>
      )}

      {editing && data && (
        <Modal onClose={() => setEditing(null)} title="角色编辑">
          <RoleEditor
            draft={editing}
            isNew={editingKey === null}
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
  onDelete,
}: {
  title: string;
  hint: string;
  roles: RoleRow[];
  empty?: string;
  canManage: boolean;
  onEdit: (r: RoleRow) => void;
  onDelete: (key: string) => void;
}) {
  return (
    <section className="rounded border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-3 py-1.5">
        <h2 className="text-xs font-medium text-slate-700">
          {title}（{roles.length}）
        </h2>
        <p className="text-[11px] text-slate-400">{hint}</p>
      </div>
      {roles.length === 0 ? (
        <p className="px-3 py-3 text-center text-xs text-slate-400">{empty ?? '（空）'}</p>
      ) : (
        <ul>
          {roles.map((r) => (
            <li key={r.key} className="border-b border-slate-100 px-3 py-2 last:border-0">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-slate-900">{r.name}</span>
                <code className="text-[11px] text-slate-400">{r.key}</code>
                {/*
                  ★ 「谁能担任」是这一行最重要的信息，放在最显眼处。
                    一个只写权限数不写担任者的角色列表，回答不了
                    「我们的测试岗现在是人还是 Agent」这个问题。
                */}
                <span
                  className={clsx(
                    'rounded px-1.5 py-0.5 text-[11px]',
                    r.appliesTo.includes('agent')
                      ? 'bg-sky-50 text-sky-800'
                      : 'bg-slate-100 text-slate-600',
                  )}
                >
                  {r.appliesTo.includes('agent') ? '👤 人 + 🤖 Agent' : '👤 仅人类'}
                </span>
                <span className="text-[11px] text-slate-400">{r.permissions.length} 项权限</span>
                <span className="text-[11px] text-slate-400">
                  在任 {r.memberCount.human} 人
                  {r.memberCount.agent > 0 && ` · ${r.memberCount.agent} 个 Agent`}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-slate-500">{r.description}</p>

              <div className="mt-1 flex gap-1.5 text-[11px]">
                {/* 查看权限谁都可以 —— 「我为什么做不了这个」的答案就在这里 */}
                <Button variant="outline"
                  onClick={() => onEdit(r)}>
                  {r.builtin || !canManage ? '查看权限' : '编辑'}
                </Button>
                {!r.builtin && (
                  <GatedButton
                    permission="org.roles.manage"
                    onClick={() => onDelete(r.key)}
                    className="rounded border border-slate-300 px-1.5 py-0.5 text-slate-600 hover:bg-slate-50"
                  >
                    删除
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
  available,
  readOnly,
  pending,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  isNew: boolean;
  available: AvailablePermission[];
  /** 内置角色、或调用者没有 org.roles.manage —— 表单变成一份可读的说明书 */
  readOnly: boolean;
  pending: boolean;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, AvailablePermission[]>();
    for (const p of available) {
      const key = GROUP_LABELS[p.group] ?? p.group;
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    return [...map.entries()];
  }, [available]);

  /**
   * ★★ 勾了 Human Gate 权限就锁掉 Agent 选项，并说明是哪几条。
   *
   *   服务端当然也会拒（roles.ts 的 validateRoleDefinition），但让人
   *   填完一整个表单再被驳回是很差的体验 —— 更糟的是他不会理解
   *   「为什么不行」，只会觉得这个功能有 bug。这里当场把因果摆出来。
   */
  const blocking = [...draft.permissions].filter(
    (p) => available.find((a) => a.key === p)?.humanOnly,
  );
  const agentAllowed = blocking.length === 0;

  /** 内置角色（或没有写权限时）表单只读 —— 它是一份可读的说明书 */
  const locked = readOnly || (!isNew && draft.builtin);

  const toggle = (p: Permission) => {
    if (locked) return;
    const next = new Set(draft.permissions);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    onChange({ ...draft, permissions: next });
  };

  return (
    <div className="max-h-[80vh] w-[560px] overflow-y-auto p-4">
      <h2 className="text-sm font-semibold text-slate-900">
        {isNew ? '新建角色' : `${locked ? '' : '编辑'}「${draft.name}」`}
      </h2>
      {locked && (
        <p className="mt-0.5 text-[11px] text-slate-500">
          {draft.builtin
            ? '内置角色就是权限矩阵本身，不可修改 —— 要不一样请新建一个角色'
            : '你没有定义角色的权限，这里只能看'}
        </p>
      )}

      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-slate-600">显示名</span>
          <Input
            value={draft.name}
            disabled={locked}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            placeholder="研发"
            className="disabled:bg-slate-50 disabled:text-slate-500" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-slate-600">
            标识
            <span className="ml-1 text-[11px] text-slate-400">Policy 规则里引用它</span>
          </span>
          <Input
            value={draft.key}
            disabled={!isNew || locked}
            onChange={(e) => onChange({ ...draft, key: e.target.value })}
            placeholder="dev"
            className="disabled:bg-slate-50 disabled:text-slate-400" />
        </label>
      </div>

      <label className="mt-2 flex flex-col gap-1 text-xs">
        <span className="text-slate-600">这个角色是做什么的</span>
        <Input
          value={draft.description}
          disabled={locked}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
          placeholder="写代码、跑测试、接管任务；不参与需求与计划审批"
          className="disabled:bg-slate-50 disabled:text-slate-500" />
      </label>

      {/* ── 谁来担任 ── */}
      <div className="mt-3 rounded border border-slate-200 bg-slate-50 px-3 py-2">
        <p className="text-xs font-medium text-slate-700">谁来担任这个角色</p>
        <label className="mt-1 flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={draft.agents && agentAllowed}
            disabled={!agentAllowed || locked}
            onChange={(e) => onChange({ ...draft, agents: e.target.checked })}
            className="mt-0.5"
          />
          <span className={clsx(!agentAllowed && 'text-slate-400')}>
            允许 Agent 担任
            <span className="ml-1 text-[11px] text-slate-400">
              （人类总是可以担任）
            </span>
          </span>
        </label>
        {!agentAllowed && (
          <p className="mt-1 text-[11px] text-amber-800">
            ⚠ 这个角色含有只能由人类行使的权限：
            {blocking.map((p) => available.find((a) => a.key === p)?.label).join('、')}。
            它们是「人类始终掌握最终决策权」的落点 —— 去掉它们才能给 Agent。
          </p>
        )}
      </div>

      {/* ── 权限 ── */}
      <div className="mt-3">
        <p className="text-xs font-medium text-slate-700">
          权限（已选 {draft.permissions.size} 项）
        </p>
        <p className="text-[11px] text-slate-400">
          组织级权限（身份管理、定义角色、导出审计…）不在这里 ——
          它们只属于组织管理员，下放会让「能创建角色的角色」一步走到管理员
        </p>
        <div className="mt-1.5 space-y-2">
          {groups.map(([group, items]) => (
            <fieldset key={group} className="rounded border border-slate-200 px-2 py-1.5">
              <legend className="px-1 text-[11px] text-slate-500">{group}</legend>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                {items.map((p) => (
                  <label key={p.key} className="flex items-start gap-1.5 text-[11px]">
                    <input
                      type="checkbox"
                      checked={draft.permissions.has(p.key)}
                      disabled={locked}
                      onChange={() => toggle(p.key)}
                      className="mt-0.5"
                    />
                    <span className="text-slate-700">
                      {p.label}
                      {p.humanOnly && (
                        <span
                          className="ml-1 text-amber-700"
                          title="只能由人类行使 —— 勾上之后这个角色就不能给 Agent 了"
                        >
                          仅人类
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="text-xs text-slate-500">
          {locked ? '关闭' : '取消'}
        </button>
        {!locked && (
          <Button variant="neutral" size="sm"
            onClick={onSave}
            disabled={pending || !draft.name || (isNew && !draft.key)}>
            {pending ? '保存中…' : '保存'}
          </Button>
        )}
      </div>
    </div>
  );
}
