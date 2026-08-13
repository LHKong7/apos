import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { agents, projectAgentBindings, projectMembers, type Database } from '@apos/db';
import { ProjectAgentRole } from '@apos/contracts';
import { ApiError, notFound } from './errors';

/**
 * 项目 Agent 绑定 —— 「这个项目的规划 / 协调 / 评审交给谁」。
 *
 * ★★ 这一层刻意只回答「哪个 Agent 干这个角色」，不碰运行时。
 *
 *   选 Claude Code 还是 Codex 是 AgentDefinition 那一层的事（Agent 配置页），
 *   到这里那些已经定好了。把两件事放进同一个下拉框是之前的老问题：
 *   用户在项目设置里被问「用哪个 CLI」，而那个选择的后果（凭证、工具权限、
 *   资源范围）根本不在这一页上显示。
 */

export const BindingInput = z.object({
  role: ProjectAgentRole,
  /** null = 解除这一格的绑定 */
  agentId: z.string().uuid().nullable(),
  /**
   * 同一角色里的优先级，0 是主 Agent。
   *
   * ★ 主 Agent 不可用时按这个顺序往下退（见 agent-provider 的 pickAgent）。
   */
  priority: z.number().int().min(0).max(4).default(0),
});

export async function listProjectAgents(db: Database, projectId: string) {
  const bindings = await db
    .select({
      id: projectAgentBindings.id,
      role: projectAgentBindings.role,
      priority: projectAgentBindings.priority,
      agentId: projectAgentBindings.agentId,
      agentName: agents.name,
      runtimeKind: agents.runtimeKind,
      status: agents.status,
      applicableTypes: agents.applicableTypes,
      updatedAt: projectAgentBindings.updatedAt,
    })
    .from(projectAgentBindings)
    .innerJoin(agents, eq(agents.id, projectAgentBindings.agentId))
    .where(eq(projectAgentBindings.projectId, projectId))
    .orderBy(asc(projectAgentBindings.role), asc(projectAgentBindings.priority));

  /**
   * ★ 可选项只列**本项目成员**里的 Agent。
   *
   *   列出整个组织的话，用户会选到一个没被加进这个项目的 Agent，
   *   保存时才被拒 —— 而那条报错出现在提交之后，不在选择的时候。
   */
  const available = await db
    .select({
      agentId: agents.id,
      name: agents.name,
      runtimeKind: agents.runtimeKind,
      status: agents.status,
      applicableTypes: agents.applicableTypes,
      skills: agents.skills,
    })
    .from(projectMembers)
    .innerJoin(agents, eq(agents.id, projectMembers.actorId))
    .where(
      and(eq(projectMembers.projectId, projectId), eq(projectMembers.actorType, 'agent')),
    );

  return { bindings, available };
}

/**
 * 绑定 / 解绑一个角色。
 *
 * ★ 校验放在保存这一刻，理由与仓库登记那边一样：等到第一次分析才发现
 *   「这个 Agent 不适用于 requirement」，代价是一次白跑的规划，
 *   而那时用户已经在等结果了。
 */
export async function setProjectAgent(
  db: Database,
  ctx: { orgId: string; projectId: string; userId: string },
  input: z.infer<typeof BindingInput>,
) {
  if (input.agentId === null) {
    // ★ 只解绑这一格，不是整个角色 —— 清主 Agent 不该顺手把备选也删了
    await db
      .delete(projectAgentBindings)
      .where(
        and(
          eq(projectAgentBindings.projectId, ctx.projectId),
          eq(projectAgentBindings.role, input.role),
          eq(projectAgentBindings.priority, input.priority),
        ),
      );
    return { ok: true as const, role: input.role, agentId: null, priority: input.priority };
  }

  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId));
  if (!agent) throw notFound('Agent');
  if (agent.orgId !== ctx.orgId) throw notFound('Agent');

  const [member] = await db
    .select({ actorId: projectMembers.actorId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, ctx.projectId),
        eq(projectMembers.actorType, 'agent'),
        eq(projectMembers.actorId, input.agentId),
      ),
    );
  if (!member) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `${agent.name} 不是这个项目的成员 —— 先在「成员与角色」里把它加进来`,
      { agentId: input.agentId },
    );
  }

  /**
   * ★ planner 必须能处理 requirement，否则绑上去也跑不动。
   *   coordinator / reviewer 暂不校验类型：它们的判据还没定死，
   *   现在卡死会把「先绑上再配」这条正常路径堵住。
   */
  if (input.role === 'planner' && !agent.applicableTypes.includes('requirement')) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `${agent.name} 的适用类型里没有 requirement，做不了规划 —— 在 Agent 配置里勾上它`,
      { agentId: input.agentId, applicableTypes: agent.applicableTypes },
    );
  }

  await db
    .insert(projectAgentBindings)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      role: input.role,
      priority: input.priority,
      agentId: input.agentId,
      createdBy: ctx.userId,
    })
    .onConflictDoUpdate({
      target: [
        projectAgentBindings.projectId,
        projectAgentBindings.role,
        projectAgentBindings.priority,
      ],
      set: { agentId: input.agentId, updatedAt: new Date() },
    });

  return { ok: true as const, role: input.role, agentId: input.agentId, priority: input.priority };
}
