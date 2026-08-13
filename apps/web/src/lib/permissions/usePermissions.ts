import { t } from '../i18n';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { qk } from '../query/keys';
import { useAuthStore } from '../../stores/auth';
import type { Permission, ProjectRole } from '../api/types';

/**
 * 当前身份在这个项目里能做什么（docs/tech/09-security.md §2）。
 *
 * ★ 判定来自服务端，前端不重算。同一份规则两份实现，偏差要么是
 *   「能点但做不了」，要么是「做得了但点不到」—— 而这套矩阵管的是
 *   「谁能放宽 Policy」「谁能扩大 Agent 权限」，两种偏差都不能接受。
 *
 * ★ 前端的判定只用来灰按钮。服务端仍然独立判一遍：
 *   共用一份规则不等于信任前端，灰按钮不是权限。
 */
export interface PermissionView {
  /** 判定就绪之前一律返回 false —— 见 {@link can} 的说明 */
  can: (permission: Permission) => boolean;
  /** 灰掉的按钮必须能说出为什么，否则用户会反复点它 */
  why: (permission: Permission) => string | undefined;
  projectRole: ProjectRole | null;
  orgRole: string | null;
  loading: boolean;
}

export function usePermissions(projectIdArg?: string): PermissionView {
  const params = useParams<{ projectId?: string }>();
  const projectId = projectIdArg ?? params.projectId;
  const userId = useAuthStore((s) => s.userId);

  const query = useQuery({
    queryKey: qk.permissions(projectId ?? 'none'),
    queryFn: () => api.permissions(projectId!),
    enabled: Boolean(projectId && userId),
    // 角色不会自己变；变了会走 SSE / 手动作废
    staleTime: 5 * 60_000,
  });

  const data = query.data;

  return {
    /**
     * ★ 没拿到判定时返回 false，不是 true。
     *
     *   乐观的默认会让页面在加载的那半秒里把所有按钮都点亮 ——
     *   手快的人点下去，收到一个 403 弹窗。宁可短暂地少几个按钮，
     *   也不要给一个会被服务端打回来的按钮。
     */
    can: (permission) => data?.permissions[permission] ?? false,
    why: (permission) => {
      if (!data) return t('perm.checking');
      return data.denyReasons[permission];
    },
    projectRole: data?.projectRole ?? null,
    orgRole: data?.orgRole ?? null,
    loading: query.isPending,
  };
}
