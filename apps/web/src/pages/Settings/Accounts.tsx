import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { GatedButton } from '../../components/Gated';
import { CardSkeleton, ErrorState } from '../../components/states';

/**
 * 账号管理（09-security §2.2「org_admin：身份管理」）。
 *
 * ★★ 这是账号进入系统的唯一入口。第一个超管来自 .env，之后所有人由他开号 ——
 *   **没有自助注册**：组织边界就是多租户边界，能自助注册等于任何人
 *   都能把自己放进某个租户里。
 *
 * ★ 建号时必须当场设一个初始口令，并且建完就把它显示出来让管理员转交。
 *   做成「系统发邮件」的话，这个实例没有邮件通道，结果是账号建好了
 *   但没人知道口令 —— 一个建完就没法用的功能。
 */
export function AccountsPage() {
  const qc = useQueryClient();
  const { projectId } = useParams<{ projectId: string }>();
  /** 与「成员与角色」共用同一个 key —— 那边加完人也要让这份名单跟着变 */
  const directory = useQuery({ queryKey: ['orgDirectory'], queryFn: () => api.orgUsers() });

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', orgRole: 'member' });
  const [created, setCreated] = useState<{ name: string; email: string; password: string } | null>(
    null,
  );

  const create = useMutation({
    mutationFn: () => api.createAccount(form),
    onSuccess: () => {
      setCreated({ name: form.name, email: form.email, password: form.password });
      setOpen(false);
      setForm({ name: '', email: '', password: '', orgRole: 'member' });
      void qc.invalidateQueries({ queryKey: ['orgDirectory'] });
      void qc.invalidateQueries({ queryKey: qk.users() });
    },
  });

  const error =
    create.error instanceof ApiError ? create.error.message : create.error ? '建号失败' : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">账号</h1>
          <Link
            to={`/projects/${projectId}/settings/members`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            ← 成员与角色
          </Link>
          <div className="ml-auto">
            <GatedButton
              permission="organization.members.manage"
              projectId={projectId}
              onClick={() => {
                setCreated(null);
                setOpen(true);
              }}
              className="rounded bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-700"
            >
              开账号
            </GatedButton>
          </div>
        </div>
        <p className="mt-0.5 text-[11px] text-slate-400">
          本组织的全部账号。开完号还要到具体项目的「成员与角色」里指派项目角色，他才看得到那个项目
        </p>
      </div>

      {directory.isPending && (
        <div className="p-4">
          <CardSkeleton />
        </div>
      )}
      {directory.isError && (
        <div className="p-4">
          <ErrorState error={directory.error} onRetry={() => void directory.refetch()} />
        </div>
      )}

      {directory.data && (
        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-3">
          <div className="mx-auto max-w-3xl space-y-3">
            {/*
              ★ 初始口令只在这一次显示。库里存的是 scrypt 散列，
                这一刻之后谁也读不出来 —— 所以要说清楚「现在就转交」，
                否则管理员关掉页面就只能重开一个号。
            */}
            {created && (
              <section className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2">
                <h2 className="text-xs font-medium text-emerald-900">
                  已为 {created.name} 开号
                </h2>
                <dl className="mt-1.5 space-y-0.5 text-[11px] text-emerald-900">
                  <div>
                    邮箱 <code className="font-mono">{created.email}</code>
                  </div>
                  <div>
                    初始口令 <code className="font-mono">{created.password}</code>
                  </div>
                </dl>
                <p className="mt-1.5 text-[11px] text-emerald-700">
                  口令只显示这一次（库里存的是散列，读不回来）。请现在就转交给他，
                  并让他登录后自行修改。
                </p>
                <button
                  type="button"
                  className="mt-1 text-[11px] text-emerald-800 underline"
                  onClick={() => setCreated(null)}
                >
                  我已转交
                </button>
              </section>
            )}

            {open && (
              <section className="rounded border border-slate-300 bg-white px-3 py-2">
                <h2 className="text-xs font-medium text-slate-700">开一个新账号</h2>
                <form
                  className="mt-2 space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    create.mutate();
                  }}
                >
                  <div className="grid grid-cols-2 gap-2">
                    <Field
                      label="姓名"
                      value={form.name}
                      onChange={(name) => setForm((f) => ({ ...f, name }))}
                    />
                    <Field
                      label="邮箱"
                      type="email"
                      value={form.email}
                      onChange={(email) => setForm((f) => ({ ...f, email }))}
                    />
                    <Field
                      label="初始口令（至少 8 位）"
                      value={form.password}
                      onChange={(password) => setForm((f) => ({ ...f, password }))}
                    />
                    <label className="block">
                      <span className="text-[11px] text-slate-500">组织角色</span>
                      <select
                        value={form.orgRole}
                        onChange={(e) => setForm((f) => ({ ...f, orgRole: e.target.value }))}
                        className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                      >
                        <option value="member">成员</option>
                        <option value="org_admin">组织管理员</option>
                      </select>
                    </label>
                  </div>

                  {error && <p className="text-[11px] text-rose-600">{error}</p>}

                  <div className="flex gap-1.5">
                    <button
                      type="submit"
                      disabled={create.isPending}
                      className="rounded bg-slate-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      {create.isPending ? '创建中…' : '创建'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setOpen(false)}
                      className="rounded border border-slate-300 px-2.5 py-1 text-xs text-slate-600"
                    >
                      取消
                    </button>
                  </div>
                </form>
              </section>
            )}

            <section className="rounded border border-slate-200 bg-white">
              {directory.data.users.map((u) => (
                <div
                  key={u.id}
                  className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 last:border-b-0"
                >
                  <span className="text-xs text-slate-800">{u.name}</span>
                  <span className="text-[11px] text-slate-400">{u.email}</span>
                  <span className="ml-auto text-[11px] text-slate-500">{u.orgRoleLabel}</span>
                </div>
              ))}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-[11px] text-slate-500">{label}</span>
      <input
        type={type}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
      />
    </label>
  );
}
