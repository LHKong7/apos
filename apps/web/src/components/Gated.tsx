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
export function RoleBadge({ projectId }: { projectId?: string }) {
  const t = useT();
  const perms = usePermissions(projectId);
  if (!perms.projectRole) return null;

  return (
    <span
      className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600"
      title={t('gated.roleTitle', { role: perms.projectRole ?? '' })}
    >
      {ROLE_KEYS[perms.projectRole] ? t(ROLE_KEYS[perms.projectRole]!) : perms.projectRole}
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
