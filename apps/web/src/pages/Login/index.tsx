import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api/client';
import { useAuthStore } from '../../stores/auth';

/**
 * 登录页。
 *
 * ★★ 在此之前这里是一个下拉框：/users 拿回全库用户，选中谁就是谁。
 *   现在账号由超管创建（.env 里那个超管除外），登录要口令。
 *
 * ★ 不提供「注册」入口，也不该提供：组织边界就是多租户边界，
 *   能自助注册等于任何人都能把自己放进某个租户里。
 *   拿不到账号的人该去找管理员，所以这句话直接写在页面上 ——
 *   否则他会一直在找那个不存在的注册按钮。
 */
export function LoginPage() {
  const signIn = useAuthStore((s) => s.signIn);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = useMutation({
    mutationFn: () => api.login({ email, password }),
    onSuccess: (data) => signIn(data.token, data.user),
  });

  const message =
    submit.error instanceof ApiError
      ? submit.error.message
      : submit.error
        ? '登录失败，请确认后端是否可达'
        : null;

  return (
    <div className="flex flex-1 items-center justify-center bg-slate-50 p-8">
      <form
        className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
        onSubmit={(e) => {
          e.preventDefault();
          submit.mutate();
        }}
      >
        <h1 className="text-base font-semibold text-slate-900">登录 Autonomous Project OS</h1>

        <label className="mt-5 block text-xs text-slate-600" htmlFor="login-email">
          邮箱
        </label>
        <input
          id="login-email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
        />

        <label className="mt-3 block text-xs text-slate-600" htmlFor="login-password">
          口令
        </label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
        />

        {/*
          ★ 错误如实照搬服务端那句话。服务端刻意让「邮箱不存在」和
            「口令不对」说同一句（否则登录接口就成了通讯录枚举探针），
            前端再加工一次只会把那份克制毁掉。
        */}
        {message && (
          <p role="alert" className="mt-3 text-xs text-rose-600">
            {message}
          </p>
        )}

        <button
          type="submit"
          disabled={submit.isPending}
          className="mt-5 w-full rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {submit.isPending ? '登录中…' : '登录'}
        </button>

        <p className="mt-4 border-t border-slate-100 pt-3 text-[11px] leading-relaxed text-slate-500">
          没有账号请找组织管理员开通 —— 这个系统不开放自助注册。
          <br />
          首次部署时，超级管理员来自 <code className="text-slate-600">.env</code> 里的{' '}
          <code className="text-slate-600">APOS_SUPERADMIN_EMAIL</code> 与{' '}
          <code className="text-slate-600">APOS_SUPERADMIN_PASSWORD</code>。
        </p>
      </form>
    </div>
  );
}
