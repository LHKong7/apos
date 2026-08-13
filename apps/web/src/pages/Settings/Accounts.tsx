import { useT } from '../../lib/i18n';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { GatedButton } from '../../components/Gated';
import { CardSkeleton, ErrorState } from '../../components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * 账号管理（09-security §2.2「org_admin：身份管理」）。
 *
 * ★★ 这是把人放进**本组织**的唯一入口。账号本身还有另外两个来源
 *   （.env 自举的第一个超管、自助注册），但那两条路都进不到别人的组织里 ——
 *   自助注册开的是一个空的新组织。组织边界就是多租户边界，
 *   「谁能进这个组织」必须只由这一页决定。
 *
 * ★ 建号时必须当场设一个初始口令，并且建完就把它显示出来让管理员转交。
 *   做成「系统发邮件」的话，这个实例没有邮件通道，结果是账号建好了
 *   但没人知道口令 —— 一个建完就没法用的功能。
 */
export function AccountsPage() {
  const t = useT();
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
    create.error instanceof ApiError ? create.error.message : create.error ? t('accounts.createFailed') : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">{t('accounts.title')}</h1>
          <Link
            to={`/projects/${projectId}/settings/members`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            {t('accounts.backToMembers')}
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
              {t('accounts.create')}
            </GatedButton>
          </div>
        </div>
        <p className="mt-0.5 text-[11px] text-slate-400">
          {t('accounts.hint')}
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
                  {t('accounts.created', { name: created.name })}
                </h2>
                <dl className="mt-1.5 space-y-0.5 text-[11px] text-emerald-900">
                  <div>
                    {t('accounts.email')} <code className="font-mono">{created.email}</code>
                  </div>
                  <div>
                    {t('accounts.initialPassword')}{' '}
                    <code className="font-mono">{created.password}</code>
                  </div>
                </dl>
                <p className="mt-1.5 text-[11px] text-emerald-700">
                  {t('accounts.passwordOnce')}
                </p>
                <button
                  type="button"
                  className="mt-1 text-[11px] text-emerald-800 underline"
                  onClick={() => setCreated(null)}
                >
                  {t('accounts.handedOver')}
                </button>
              </section>
            )}

            {open && (
              <section className="rounded border border-slate-300 bg-white px-3 py-2">
                <h2 className="text-xs font-medium text-slate-700">{t('accounts.new')}</h2>
                <form
                  className="mt-2 space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    create.mutate();
                  }}
                >
                  <div className="grid grid-cols-2 gap-2">
                    <Field
                      label={t('accounts.name')}
                      value={form.name}
                      onChange={(name) => setForm((f) => ({ ...f, name }))}
                    />
                    <Field
                      label={t('accounts.email')}
                      type="email"
                      value={form.email}
                      onChange={(email) => setForm((f) => ({ ...f, email }))}
                    />
                    <Field
                      label={t('accounts.initialPassword')}
                      value={form.password}
                      onChange={(password) => setForm((f) => ({ ...f, password }))}
                    />
                    <label className="block">
                      <span className="text-[11px] text-slate-500">{t('accounts.orgRole')}</span>
                      <select
                        value={form.orgRole}
                        onChange={(e) => setForm((f) => ({ ...f, orgRole: e.target.value }))}
                        className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                      >
                        <option value="member">{t('accounts.member')}</option>
                        <option value="org_admin">{t('accounts.orgAdmin')}</option>
                      </select>
                    </label>
                  </div>

                  {error && <p className="text-[11px] text-rose-600">{error}</p>}

                  <div className="flex gap-1.5">
                    <Button variant="neutral" size="sm"
                      type="submit"
                      disabled={create.isPending}>
                      {create.isPending ? t('project.creating') : t('project.create')}
                    </Button>
                    <Button variant="outline" size="sm"
                      onClick={() => setOpen(false)}>
                      {t('common.cancel')}
                    </Button>
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
      <Input
        type={type}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5" />
    </label>
  );
}
