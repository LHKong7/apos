import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api/client';
import { useAuthStore } from '../../stores/auth';
import { BrandMark } from '../../components/BrandMark';

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
 *
 * ★ 这是整个产品的第一屏，也是唯一一屏「没有数据可看」的页面 ——
 *   所以它是**唯一**适合把产品那一句话讲出来的地方。左侧那段字
 *   不是装饰：它解释了为什么这个系统的登录页上没有注册按钮。
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
    <div className="relative flex min-h-screen flex-1 items-center justify-center overflow-hidden p-6">
      {/* 底纹：网格向四周淡出 + 两团极光。只在登录页给到这个强度 ——
          进了系统之后，会发光的应该是数据而不是背景 */}
      <div aria-hidden className="grid-fade pointer-events-none absolute inset-0" />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 -top-40 h-[32rem] w-[32rem] rounded-full bg-brand/20 blur-[110px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-48 -right-32 h-[34rem] w-[34rem] rounded-full bg-brand-far/20 blur-[120px]"
      />

      <div className="relative grid w-full max-w-4xl items-center gap-10 md:grid-cols-[1fr_22rem]">
        {/* 左：产品是什么。窄屏收起 —— 手机上登录的人要的是输入框 */}
        <div className="hidden md:block">
          <div className="flex items-center gap-2.5">
            <BrandMark className="h-9 w-9" />
            <div>
              <p className="text-lg font-semibold tracking-tight text-slate-900">
                Autonomous Project OS
              </p>
              <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">
                Human · Agent · One Board
              </p>
            </div>
          </div>

          <h1 className="mt-7 max-w-md text-2xl font-semibold leading-snug tracking-tight text-slate-800">
            让项目<span className="text-gradient-brand">自主向前流动</span>，
            <br />
            关键节点上始终有人。
          </h1>

          <ul className="mt-6 space-y-2.5">
            {HIGHLIGHTS.map((h) => (
              <li key={h.title} className="flex items-start gap-2.5">
                <span
                  aria-hidden
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-br from-brand-alt to-brand-far"
                />
                <p className="text-xs leading-relaxed text-slate-500">
                  <span className="font-medium text-slate-700">{h.title}</span>
                  <span className="mx-1.5 text-slate-300">·</span>
                  {h.body}
                </p>
              </li>
            ))}
          </ul>
        </div>

        {/* 右：登录表单 */}
        <form
          className="w-full rounded-xl border border-slate-200 p-6 shadow-lg glass-strong"
          onSubmit={(e) => {
            e.preventDefault();
            submit.mutate();
          }}
        >
          <div className="flex items-center gap-2 md:hidden">
            <BrandMark className="h-7 w-7" />
            <span className="text-sm font-semibold tracking-tight text-slate-900">
              Autonomous Project OS
            </span>
          </div>

          <h2 className="mt-4 text-base font-semibold tracking-tight text-slate-900 md:mt-0">
            登录
          </h2>
          <p className="mt-1 text-[11px] text-slate-400">用组织管理员开通的账号进入</p>

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
            className="mt-1.5 w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm"
          />

          <label className="mt-3.5 block text-xs text-slate-600" htmlFor="login-password">
            口令
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1.5 w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm"
          />

          {/*
            ★ 错误如实照搬服务端那句话。服务端刻意让「邮箱不存在」和
              「口令不对」说同一句（否则登录接口就成了通讯录枚举探针），
              前端再加工一次只会把那份克制毁掉。
          */}
          {message && (
            <p
              role="alert"
              className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs text-rose-600"
            >
              {message}
            </p>
          )}

          <button
            type="submit"
            disabled={submit.isPending}
            className="mt-5 w-full rounded-md bg-gradient-to-r from-brand-alt via-brand to-brand-far px-3 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110 disabled:opacity-50"
          >
            {submit.isPending ? '登录中…' : '登录'}
          </button>

          <p className="mt-4 border-t border-slate-200/70 pt-3 text-[11px] leading-relaxed text-slate-500">
            没有账号请找组织管理员开通 —— 这个系统不开放自助注册。
            <br />
            首次部署时，超级管理员来自 <code className="text-slate-600">.env</code> 里的{' '}
            <code className="text-slate-600">APOS_SUPERADMIN_EMAIL</code> 与{' '}
            <code className="text-slate-600">APOS_SUPERADMIN_PASSWORD</code>。
          </p>
        </form>
      </div>
    </div>
  );
}

/** 三句话说清这个系统和一块普通看板的差别 —— 再多就没人读了 */
const HIGHLIGHTS = [
  { title: '需求进来自己往下走', body: '澄清、计划、拆解、调度，由 Flow Engine 推动' },
  { title: '要你决定时才来找你', body: 'Human Gate 拦在风险处，超时会升级，不会静默通过' },
  { title: '人和 Agent 同一块板', body: '谁在做、卡在哪、花了多少，一眼看得到' },
];
