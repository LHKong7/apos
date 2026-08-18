import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { api, ApiError } from '../../lib/api/client';
import { useAuthStore } from '../../stores/auth';
import { useT, type MessageKey } from '../../lib/i18n';
import { BrandMark } from '../../components/BrandMark';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

type Mode = 'login' | 'register';

/**
 * 登录 / 注册页。
 *
 * ★★ 注册开的是一个**自己的新组织**，不是加入某个已有组织。
 *
 *   这两件事在多租户里差得很远：后者等于「任何人都能把自己放进别人的
 *   边界里」，那正是这套系统当初拒绝自助注册的理由；而前者只是多了一个
 *   空租户，谁也看不见谁。所以注册表单上那句「会为你创建一个新组织」
 *   不是宣传语，是这条设计线本身 —— 用户要能预期到他注册完看到的是空的。
 *
 * ★ 这是整个产品的第一屏，也是唯一一屏「没有数据可看」的页面 ——
 *   所以它是唯一适合把产品那一句话讲出来的地方。
 */
export function LoginPage() {
  const signIn = useAuthStore((s) => s.signIn);
  const t = useT();
  const [mode, setMode] = useState<Mode>('login');

  /**
   * ★ 注册开不开由服务端说了算（APOS_ALLOW_SIGNUP）。
   *   拿不到配置时按**关**渲染：给一个点了必然失败的入口，
   *   比没有入口更糟 —— 用户会以为是自己填错了。
   */
  const config = useQuery({
    queryKey: ['authConfig'],
    queryFn: api.authConfig,
    staleTime: Infinity,
    retry: false,
  });
  const allowSignup = config.data?.allowSignup === true;

  /**
   * ★ 关掉注册之后，生效的模式只能是登录。
   *   直接用 mode 的话，配置刷新一次就可能留下一个填了一半、
   *   提交必然 403 的注册表单 —— 而用户完全不知道发生了什么。
   */
  const active: Mode = allowSignup ? mode : 'login';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [orgName, setOrgName] = useState('');

  const submit = useMutation({
    mutationFn: () =>
      active === 'login'
        ? api.login({ email, password })
        : api.register({
            email,
            name: name.trim(),
            password,
            ...(orgName.trim() ? { orgName: orgName.trim() } : {}),
          }),
    onSuccess: (data) => signIn(data.token, data.user),
  });

  const message =
    submit.error instanceof ApiError
      ? submit.error.message
      : submit.error
        ? t('login.failed', {
            action: active === 'login' ? t('login.tab.login') : t('login.tab.register'),
          })
        : null;

  /** ★ 换模式要清掉上一次的报错：「邮箱或口令不正确」留在注册表单上纯属误导 */
  const switchTo = (next: Mode) => {
    if (next === mode) return;
    submit.reset();
    setMode(next);
  };

  const canSubmit =
    Boolean(email.trim()) && Boolean(password) && (active === 'login' || Boolean(name.trim()));

  return (
    <div className="relative flex min-h-screen flex-1 items-center justify-center overflow-hidden p-6">
      {/* 底纹：网格向四周淡出 + 两团极光。只在这一屏给到这个强度 ——
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

      <div className="relative grid w-full max-w-4xl items-center gap-10 md:grid-cols-[1fr_23rem]">
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
            {t('login.hero.line1')}
            <span className="text-gradient-brand">{t('login.hero.highlight')}</span>
            <br />
            {t('login.hero.line2')}
          </h1>

          <ul className="mt-6 space-y-2.5">
            {HIGHLIGHTS.map((h) => (
              <li key={h.titleKey} className="flex items-start gap-2.5">
                <span
                  aria-hidden
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-br from-brand-alt to-brand-far"
                />
                <p className="text-xs leading-relaxed text-slate-500">
                  <span className="font-medium text-slate-700">{t(h.titleKey)}</span>
                  <span className="mx-1.5 text-slate-300">·</span>
                  {t(h.bodyKey)}
                </p>
              </li>
            ))}
          </ul>
        </div>

        {/* 右：表单 */}
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

          {/*
            分段控件而不是「还没有账号？去注册」那种小字链接 ——
            开着注册的实例里，两者是平级的两条路，不是主次。

            ★ 配置还没回来时占住同样的高度：等它回来再插进去的话，
              整张卡片会往下跳一截，而用户那时可能正在输邮箱。
          */}
          {config.isPending ? (
            <div aria-hidden className="mt-4 h-[2.125rem] md:mt-0" />
          ) : allowSignup ? (
            <div className="mt-4 flex rounded-lg border border-slate-200 bg-slate-100/60 p-0.5 md:mt-0">
              {(
                [
                  { key: 'login', labelKey: 'login.tab.login' },
                  { key: 'register', labelKey: 'login.tab.register' },
                ] as const
              ).map((tab) => (
                <Button variant="ghost"
                  key={tab.key}
                  onClick={() => switchTo(tab.key)}
                  aria-pressed={active === tab.key}
                  className={clsx('h-auto p-0 font-normal whitespace-normal hover:bg-transparent', 
                    'flex-1 rounded-md py-1.5 text-xs transition',
                    active === tab.key
                      ? 'bg-white font-medium text-slate-900 shadow-sm'
                      : 'text-slate-500 hover:text-slate-800',
                  )}
                >
                  {t(tab.labelKey)}
                </Button>
              ))}
            </div>
          ) : (
            <h2 className="mt-4 text-base font-semibold tracking-tight text-slate-900 md:mt-0">
              {t('login.tab.login')}
            </h2>
          )}

          <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
            {active === 'login' ? t('login.intro.login') : t('login.intro.register')}
          </p>

          {active === 'register' && (
            <>
              <Label className="mt-4 block text-xs text-slate-600" htmlFor="register-name">
                {t('login.field.name')}
              </Label>
              <Input
                id="register-name"
                autoComplete="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('login.field.namePlaceholder')}
                className="mt-1.5" />
            </>
          )}

          <Label className="mt-4 block text-xs text-slate-600" htmlFor="login-email">
            {t('login.field.email')}
          </Label>
          <Input
            id="login-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1.5" />

          <Label className="mt-3.5 block text-xs text-slate-600" htmlFor="login-password">
            {t('login.field.password')}
          </Label>
          <Input
            id="login-password"
            type="password"
            autoComplete={active === 'login' ? 'current-password' : 'new-password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1.5" />
          {/* ★ 把长度要求写在前面，而不是等服务端把表单打回来才说
              —— 服务端那条规则见 modules/auth/password.ts */}
          {active === 'register' && (
            <p className="mt-1 text-[11px] text-slate-400">{t('login.field.passwordHint')}</p>
          )}

          {active === 'register' && (
            <>
              <Label className="mt-3.5 block text-xs text-slate-600" htmlFor="register-org">
                {t('login.field.orgName')}
                <span className="ml-1 text-slate-400">{t('login.field.optional')}</span>
              </Label>
              <Input
                id="register-org"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder={
                  name.trim()
                    ? t('login.field.orgPlaceholderFrom', { name: name.trim() })
                    : t('login.field.orgPlaceholder')
                }
                className="mt-1.5" />
            </>
          )}

          {/*
            ★ 错误如实照搬服务端那句话。登录那条路上，服务端刻意让
              「邮箱不存在」和「口令不对」说同一句（否则登录接口就成了
              通讯录枚举探针），前端再加工一次只会把那份克制毁掉。
          */}
          {message && (
            <p
              role="alert"
              className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs text-rose-600"
            >
              {message}
            </p>
          )}

          <Button variant="ghost"
            type="submit"
            disabled={submit.isPending || !canSubmit}
            className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent mt-5 w-full rounded-md bg-gradient-to-r from-brand-alt via-brand to-brand-far px-3 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110 disabled:opacity-50"
          >
            {submit.isPending
              ? active === 'login'
                ? t('login.submit.signingIn')
                : t('login.submit.creating')
              : active === 'login'
                ? t('login.submit.login')
                : t('login.submit.register')}
          </Button>

          <p className="mt-4 border-t border-slate-200/70 pt-3 text-[11px] leading-relaxed text-slate-500">
            {active === 'login' ? (
              <>
                {/* ★ 关着注册的实例要明说，否则用户会一直在找那个不存在的注册入口 */}
                {!allowSignup && !config.isPending && (
                  <>
                    {t('login.note.noSignup')}
                    <br />
                  </>
                )}
                {t('login.note.bootstrap')}
                {allowSignup && (
                  <>
                    <br />
                    {t('login.note.joinExisting')}
                  </>
                )}
              </>
            ) : (
              <>
                {t('login.note.newOrgEmpty')}
                <br />
                <strong className="font-medium text-slate-600">
                  {t('login.note.doNotRegister')}
                </strong>
                {t('login.note.doNotRegisterWhy')}
              </>
            )}
          </p>
        </form>
      </div>
    </div>
  );
}

/**
 * 三句话说清这个系统和一块普通看板的差别 —— 再多就没人读了。
 * Three lines on what separates this from an ordinary board; any more goes unread.
 */
const HIGHLIGHTS: { titleKey: MessageKey; bodyKey: MessageKey }[] = [
  { titleKey: 'login.highlight.1.title', bodyKey: 'login.highlight.1.body' },
  { titleKey: 'login.highlight.2.title', bodyKey: 'login.highlight.2.body' },
  { titleKey: 'login.highlight.3.title', bodyKey: 'login.highlight.3.body' },
];
