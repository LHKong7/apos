import { useT, type MessageKey } from '../lib/i18n';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Button } from '@/components/ui/button';
import { usePermissions } from '../lib/permissions/usePermissions';
import type { Permission } from '../lib/api/types';

/**
 * 按权限灰掉的按钮（docs/tech/09-security.md §2）。
 *
 * ★★ 灰掉的同时必须说清楚为什么，这是这个组件存在的全部理由。
 *
 *   一个「无权限」的灰按钮会让用户反复点它、然后去问同事「这个是不是坏了」。
 *   而拒绝理由里带着「该找谁」（「批准计划需要 tech_lead」），
 *   用户当场就知道下一步是去找谁 —— 服务端算好了这句话，
 *   界面只是把它挂上去。
 *
 * ★ 灰按钮不是权限。这里只影响可点性，服务端仍会独立判一遍 ——
 *   直接打 API 或者用一个旧版本的前端，照样会被 403 挡回去。
 */
export interface GatedButtonProps {
  permission: Permission;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  /** 权限之外的禁用原因（状态机不允许、表单没填完之类） */
  disabled?: boolean;
  disabledReason?: string;
  type?: 'button' | 'submit';
  projectId?: string;
  /**
   * 开关类按钮的当前状态。
   *
   * ★ 「哪一档是选中的」在视觉上是靠底色说的，而底色对读屏软件不存在。
   *   一个三态开关如果只有颜色在表态，用读屏的人根本不知道现在是哪一档 ——
   *   而这一页管的是「Agent 能自己做什么」，读错一档的代价不小。
   */
  pressed?: boolean;
}

export function GatedButton({
  permission,
  onClick,
  children,
  className,
  disabled,
  disabledReason,
  type = 'button',
  projectId,
  pressed,
}: GatedButtonProps) {
  const perms = usePermissions(projectId);
  const denied = !perms.can(permission);
  const blocked = denied || Boolean(disabled);
  // 权限优先说 —— 两个原因都在时，「你没资格」比「现在还不能」更根本
  const reason = denied ? perms.why(permission) : disabledReason;

  /**
   * ★ 变体固定 ghost：调用点传的 className 里已经带着完整配色
   *   （全站三十多处，各自的语义不同）。挑一个有底色的变体会和它们打架，
   *   ghost 几乎不加东西，而 cva 把 className 排在最后，
   *   tailwind-merge 保证调用点仍然赢。这里要的只是 Button 的基础
   *   行为：type 默认 button、焦点环、disabled 语义。
   *
   *   Pinned to the ghost variant because callers already pass their own full
   *   color classes. A variant with a background would fight them; ghost adds
   *   almost nothing, and cva orders className last so callers still win.
   */
  return (
    <Button
      variant="ghost"
      type={type}
      onClick={onClick}
      disabled={blocked}
      title={blocked ? reason : undefined}
      aria-disabled={blocked}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      className={clsx('h-auto p-0 font-normal hover:bg-transparent', className, blocked && 'cursor-not-allowed opacity-50')}
    >
      {children}
    </Button>
  );
}

/**
 * 没权限就整块不渲染。
 *
 * ★ 用在「渲染出来也只能看」的整块区域（规则编辑器、成员管理面板）。
 *   单个按钮不要用这个 —— 凭空少一个按钮，用户会以为是版本问题；
 *   灰着并说明原因才是可理解的。
 */
export function Gated({
  permission,
  children,
  fallback,
  projectId,
}: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
  projectId?: string;
}) {
  const perms = usePermissions(projectId);
  if (!perms.can(permission)) return <>{fallback ?? null}</>;
  return <>{children}</>;
}

/** 当前身份在这个项目里的角色，放在页头让人一眼知道自己是谁 */
export function RoleBadge({
  projectId,
  compact,
  onClick,
}: {
  projectId?: string;
  /**
   * 侧栏收窄时的形态。
   *
   * ★★ 收窄时**不能整个藏起来**。这个徽标回答的是「为什么那个按钮是灰的」，
   *   而灰按钮在每一页都可能出现 —— 藏掉它等于把那个问题的唯一答案
   *   连同侧栏一起折走了（问题记录 #5）。
   *
   * ★ 也不缩写成一个字：「技」这个字比不显示更糟，用户得先猜它是什么。
   *   收窄形态是一个中性的人形轮廓 + 完整角色名的 tooltip，
   *   点它就展开侧栏 —— 徽标本身成了「展开」这件事的入口，
   *   而这正是它和折叠按钮该有的关联。
   */
  compact?: boolean;
  onClick?: () => void;
}) {
  const t = useT();
  const perms = usePermissions(projectId);
  if (!perms.projectRole) return null;

  const label = ROLE_KEYS[perms.projectRole]
    ? t(ROLE_KEYS[perms.projectRole]!)
    : perms.projectRole;
  const title = t('gated.roleTitle', { role: label });

  if (compact) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-label={title}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
          <circle cx="8" cy="5" r="3" />
          <path d="M2.5 14c0-3 2.5-4.5 5.5-4.5s5.5 1.5 5.5 4.5z" />
        </svg>
      </button>
    );
  }

  return (
    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600" title={title}>
      {label}
    </span>
  );
}

/** 项目角色 → 词条键 / Project role → message key */
const ROLE_KEYS: Record<string, MessageKey> = {
  sponsor: 'role.sponsor',
  tech_lead: 'role.tech_lead',
  pm: 'role.pm',
  member: 'role.member',
  viewer: 'role.viewer',
};
