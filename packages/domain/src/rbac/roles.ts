import { z } from 'zod';
import { ProjectRole, type ActorType } from '@apos/contracts';
import { PERMISSIONS, PERMISSION_SPECS, type Permission } from './catalog';

/**
 * 角色 —— 一组权限的名字（docs/tech/09-security.md §2.2）。
 *
 * ★★ 角色是**数据**，不是枚举。
 *
 *   内置的五个（sponsor / tech_lead / pm / member / viewer）覆盖的是
 *   「项目怎么运转」，覆盖不了「这个组织怎么分工」——研发、运营、测试、
 *   安全、数据，每家的切法都不一样。写死枚举的结果是所有人都被塞进
 *   `member`，然后权限矩阵退化成「成员 vs 管理员」两档。
 *
 * ★★ 一个角色可以由**人**担任，也可以由 **Agent** 担任。
 *
 *   这正是这个产品的形状：Human–Agent 混合团队里，「测试」这个岗位
 *   可能是一个人，也可能是一个跑测试的 Agent，还可能两者都有。
 *   把「角色」和「谁来担任」分开，混合团队才描述得出来。
 *
 *   但 Agent 能担任的角色有硬边界，见 {@link validateRoleDefinition}：
 *   带 `humanOnly` 权限的角色**永远**不能给 Agent。
 *   §7.2 那句「如果 Agent 能改自己的约束，整个治理体系就是装饰」
 *   在这里的推论是：也不能靠自定义一个角色绕过去。
 */

/** 角色标识。跨项目稳定，Policy 的 `{kind:'project_role', role}` 引用的就是它 */
export const RoleKey = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{1,31}$/,
    '角色标识只能用小写字母、数字和下划线，以字母开头，2–32 个字符',
  );
export type RoleKey = z.infer<typeof RoleKey>;

/** 谁能担任这个角色 */
export const RoleAssignee = z.enum(['human', 'agent']);
export type RoleAssignee = z.infer<typeof RoleAssignee>;

export const RoleDefinition = z.object({
  key: RoleKey,
  /** 显示名，如「研发」。角色列表、成员表、Policy 解释里出现的都是它 */
  name: z.string().min(1, '角色需要一个名字').max(40),
  description: z.string().max(200).default(''),
  permissions: z.array(z.string()).default([]),
  /** 至少要能给一类人担任，否则这个角色建了也没用 */
  appliesTo: z.array(RoleAssignee).min(1, '至少要指定一类担任者'),
});
export type RoleDefinition = z.infer<typeof RoleDefinition>;

export interface Role extends RoleDefinition {
  permissions: Permission[];
  /** 内置角色不可改权限、不可删 —— 它们是权限矩阵本身 */
  builtin: boolean;
}

/**
 * 内置角色的权限集合，由权限目录**反推**而来。
 *
 * ★ 不手写第二份。目录里写的是「这条权限给哪些角色」，
 *   这里要的是「这个角色有哪些权限」—— 同一件事的两个方向。
 *   手写反向表意味着改目录时要记得同步，而漏同步的表现是
 *   「矩阵里写着 pm 能做，实际 pm 做不了」，没有任何报错。
 */
export const BUILTIN_ROLE_PERMISSIONS: Record<ProjectRole, Permission[]> = buildBuiltinIndex();

function buildBuiltinIndex(): Record<ProjectRole, Permission[]> {
  const index = Object.fromEntries(ProjectRole.options.map((r) => [r, [] as Permission[]])) as Record<
    ProjectRole,
    Permission[]
  >;
  for (const permission of PERMISSIONS) {
    for (const role of PERMISSION_SPECS[permission].projectRoles ?? []) {
      index[role].push(permission);
    }
  }
  return index;
}

const BUILTIN_META: Record<ProjectRole, { name: string; description: string }> = {
  sponsor: { name: '业务负责人', description: '需求确认、预算超限审批、业务验收、结项' },
  tech_lead: {
    name: '技术负责人',
    description: '批准计划、放宽规则、强制放行、扩大 Agent 权限',
  },
  pm: { name: '项目经理', description: '项目设置、收紧规则、调度与成员管理' },
  member: { name: '成员', description: '执行任务、接管 Agent、处理决策' },
  /**
   * ★ 唯一一个 Agent 也能担任的「干活」角色，也是自定义 Agent 角色
   *   （研发 / 测试…）的起点：复制它，再按需要加权限。
   */
  executor: { name: '执行者', description: '只执行任务，不参与任何决策与审批' },
  viewer: { name: '只读', description: '只能看，不能做任何改动' },
};

/** 内置角色。每个组织建立时都会得到一份同样的拷贝 */
export const BUILTIN_ROLES: Role[] = ProjectRole.options.map((key) => ({
  key,
  name: BUILTIN_META[key].name,
  description: BUILTIN_META[key].description,
  permissions: BUILTIN_ROLE_PERMISSIONS[key],
  appliesTo: assignableBy(BUILTIN_ROLE_PERMISSIONS[key]),
  builtin: true,
}));

/**
 * 这组权限能给谁担任。
 *
 * ★ 不是让人随便勾的，是算出来的下限：带 `humanOnly` 权限的角色
 *   一律不能给 Agent。管理员可以在这个范围内再收窄
 *   （「研发这个角色我们只给人」），但放不宽。
 */
export function assignableBy(permissions: readonly Permission[]): RoleAssignee[] {
  const humanOnly = permissions.some((p) => PERMISSION_SPECS[p]?.humanOnly);
  return humanOnly ? ['human'] : ['human', 'agent'];
}

/** 自定义角色能授予的权限：项目内的那些 */
export function assignablePermissions(): Permission[] {
  return PERMISSIONS.filter((p) => PERMISSION_SPECS[p].scope !== 'org');
}

export interface RoleValidationError {
  field: 'permissions' | 'appliesTo' | 'key';
  message: string;
}

/**
 * 自定义角色的合法性。
 *
 * ★★ 三条限制，每一条都堵一条提权路径：
 *
 *   1. **不认识的权限名**直接拒。放过去的话，那条权限永远不生效，
 *      而管理员以为自己授权了 —— 一个「我明明给了他权限」的幽灵故障。
 *
 *   2. **组织级权限不下放**。允许的话，超管可以造一个「能创建角色的角色」，
 *      发给某人，那个人再造一个更宽的角色 …… 一步就从项目角色
 *      走到了组织管理员。项目角色只授项目内的能力，这条没有例外。
 *
 *   3. **humanOnly 的权限不能进 Agent 角色**。§7.2 的推论：
 *      不能靠「自定义一个叫研发的角色，把改 Policy 塞进去，再指派给 Agent」
 *      绕过「Agent 不能改自己的约束」。
 */
export function validateRoleDefinition(def: RoleDefinition): RoleValidationError[] {
  const errors: RoleValidationError[] = [];
  const known = new Set<string>(PERMISSIONS);
  const allowed = new Set<string>(assignablePermissions());

  const unknown = def.permissions.filter((p) => !known.has(p));
  if (unknown.length > 0) {
    errors.push({
      field: 'permissions',
      message: `不认识这些权限：${unknown.join('、')}`,
    });
  }

  const orgLevel = def.permissions.filter((p) => known.has(p) && !allowed.has(p));
  if (orgLevel.length > 0) {
    errors.push({
      field: 'permissions',
      message:
        `组织级权限不能下放给项目角色：${orgLevel
          .map((p) => PERMISSION_SPECS[p as Permission].label)
          .join('、')}。` + '否则一个「能创建角色的角色」就能一步走到组织管理员',
    });
  }

  if (def.appliesTo.includes('agent')) {
    const humanOnly = def.permissions.filter(
      (p) => known.has(p) && PERMISSION_SPECS[p as Permission].humanOnly,
    );
    if (humanOnly.length > 0) {
      errors.push({
        field: 'appliesTo',
        message:
          `这些权限只能由人类行使，不能放进 Agent 角色：${humanOnly
            .map((p) => PERMISSION_SPECS[p as Permission].label)
            .join('、')}。` + '要么去掉它们，要么把这个角色限定给人类',
      });
    }
  }

  return errors;
}

/** 角色能不能给这一类担任者 —— 指派时再判一次，配置错了不至于真的生效 */
export function roleAcceptsActor(role: Pick<Role, 'appliesTo'>, actorType: ActorType): boolean {
  if (actorType === 'human') return role.appliesTo.includes('human');
  if (actorType === 'agent') return role.appliesTo.includes('agent');
  // service / external / system 不进成员表
  return false;
}
