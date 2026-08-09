import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  agents,
  projectConventions,
  projects,
  repositories,
  type Database,
} from '@apos/db';
import { WorkItemType } from '@apos/contracts';
import { probeGit } from '../modules/workspace/git';
import {
  describeRef,
  encodeSecret,
  hasMasterKey,
  hintOf,
  SecretConfigError,
} from '../modules/security/secrets';
import { ApiError, notFound } from './errors';

/**
 * 项目工程约定 —— 三块信息架构里的第三块。
 *
 * 包含两类东西，它们的共同点是「跟着项目走，对该项目里所有 Agent 一视同仁」：
 *
 * 1. **代码仓库登记**：`ResourceScope { kind:'repo', ref }` 的落点。
 *    没有它，Agent 的仓库授权就只是一个没人解析的字符串。
 * 2. **工程约定**：编码规范、测试要求、提交规范。走 `TaskDispatch.context`
 *    下发，不是 Agent 的 system prompt。
 */

// ── 代码仓库 ──────────────────────────────────────────────────────────

export const RepositoryInput = z.object({
  ref: z
    .string()
    .min(1, '仓库标识不能为空')
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_.-]*$/i, '仓库标识只能包含字母、数字、-、_、.'),
  name: z.string().min(1).max(120),
  remoteUrl: z
    .string()
    .min(1, 'git 地址不能为空')
    .refine(
      (v) => /^(https?:\/\/|git@|ssh:\/\/)/.test(v),
      'git 地址必须以 https:// 、git@ 或 ssh:// 开头',
    ),
  defaultBranch: z.string().min(1).default('main'),
  branchPrefix: z.string().default('apos/'),
  /** 明文凭证或 `env:变量名`；不传 = 不改，null = 清除 */
  credential: z.string().nullable().optional(),
  /** 不传表示组织级共享仓库 */
  projectId: z.string().uuid().nullable().optional(),
});

export async function listRepositories(db: Database, orgId: string, projectId: string | null) {
  const rows = await db
    .select()
    .from(repositories)
    .where(
      projectId
        ? and(
            eq(repositories.orgId, orgId),
            or(isNull(repositories.projectId), eq(repositories.projectId, projectId)),
          )
        : eq(repositories.orgId, orgId),
    )
    .orderBy(asc(repositories.ref));

  const git = await probeGit();

  return {
    repositories: rows.map((r) => {
      const cred = describeRef(r.credentialRef);
      return {
        id: r.id,
        ref: r.ref,
        name: r.name,
        // ★ remoteUrl 可能被用户手填成带凭证的形式，回显前先抹掉
        remoteUrl: redactUrl(r.remoteUrl),
        defaultBranch: r.defaultBranch,
        branchPrefix: r.branchPrefix,
        scope: r.projectId ? 'project' : 'organization',
        projectId: r.projectId,
        status: r.status,
        credentialHint: r.credentialHint,
        credentialUsable: cred.usable,
        credentialProblem: cred.problem,
        /** 私有仓库没凭证会在派发时才失败 —— 提前说 */
        warning:
          !r.credentialRef && /^https?:\/\//.test(r.remoteUrl)
            ? '未配置凭证：私有仓库会在准备工作区时克隆失败'
            : null,
      };
    }),
    /** git 环境问题要在这一页说清楚，而不是等第一次派发才炸 */
    gitAvailable: git.ok,
    gitVersion: git.version,
    gitProblem: git.problem,
    canStoreInlineCredential: hasMasterKey(),
  };
}

export async function createRepository(
  db: Database,
  orgId: string,
  userId: string,
  input: z.infer<typeof RepositoryInput>,
) {
  const existing = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.orgId, orgId), eq(repositories.ref, input.ref)));
  if (existing.length > 0) {
    throw new ApiError('VERSION_CONFLICT', `仓库标识 ${input.ref} 已被占用`, { ref: input.ref });
  }

  if (input.projectId) {
    const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId));
    if (!p) throw notFound('项目');
  }

  const [row] = await db
    .insert(repositories)
    .values({
      orgId,
      projectId: input.projectId ?? null,
      ref: input.ref,
      name: input.name,
      remoteUrl: input.remoteUrl.trim(),
      defaultBranch: input.defaultBranch,
      branchPrefix: input.branchPrefix,
      ...credentialColumns(input.credential ?? null),
      createdBy: userId,
    })
    .returning({ id: repositories.id, ref: repositories.ref });

  return { repository: row };
}

export async function updateRepository(
  db: Database,
  repoId: string,
  input: Partial<z.infer<typeof RepositoryInput>> & { status?: 'active' | 'disabled' },
) {
  const [existing] = await db.select().from(repositories).where(eq(repositories.id, repoId));
  if (!existing) throw notFound('仓库');

  const credential = input.credential === undefined ? undefined : input.credential?.trim() || null;

  const [row] = await db
    .update(repositories)
    .set({
      ...(input.name ? { name: input.name } : {}),
      ...(input.remoteUrl ? { remoteUrl: input.remoteUrl.trim() } : {}),
      ...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}),
      ...(input.branchPrefix !== undefined ? { branchPrefix: input.branchPrefix } : {}),
      ...(credential !== undefined ? credentialColumns(credential) : {}),
      ...(input.status ? { status: input.status } : {}),
      updatedAt: new Date(),
    })
    .where(eq(repositories.id, repoId))
    .returning({ id: repositories.id });

  return { repository: row };
}

export async function deleteRepository(db: Database, repoId: string) {
  const [row] = await db.select().from(repositories).where(eq(repositories.id, repoId));
  if (!row) throw notFound('仓库');

  /**
   * ★ 还有 Agent 授权指向它就不能删 —— 删掉之后那些 Agent 的 repo 范围
   *   会变成解析不出来的字符串，表现是「派发时突然全部失败」，
   *   而错误信息里不会提到有人删了一个仓库。
   */
  const all = await db.select({ name: agents.name, scopes: agents.resourceScopes }).from(agents).where(eq(agents.orgId, row.orgId));
  const referencing = all.filter((a) =>
    a.scopes.some((s) => s.kind === 'repo' && s.ref === row.ref && s.access !== 'none'),
  );
  if (referencing.length > 0) {
    throw new ApiError(
      'VERSION_CONFLICT',
      `还有 ${referencing.length} 个 Agent 的资源范围指向仓库 ${row.ref}`,
      { agents: referencing.map((a) => a.name) },
    );
  }

  await db.delete(repositories).where(eq(repositories.id, repoId));
  return { ok: true as const };
}

// ── 工程约定 ──────────────────────────────────────────────────────────

export const ConventionInput = z.object({
  title: z.string().min(1, '标题不能为空').max(120),
  content: z.string().min(1, '内容不能为空').max(20_000),
  appliesTo: z.array(WorkItemType).default([]),
  priority: z.enum(['must_read', 'reference']).default('must_read'),
  enabled: z.boolean().default(true),
  position: z.number().int().min(0).default(0),
});

export async function listConventions(db: Database, projectId: string) {
  const rows = await db
    .select()
    .from(projectConventions)
    .where(eq(projectConventions.projectId, projectId))
    .orderBy(asc(projectConventions.position), asc(projectConventions.createdAt));

  return {
    conventions: rows.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      appliesTo: r.appliesTo,
      priority: r.priority,
      enabled: r.enabled,
      position: r.position,
      updatedAt: r.updatedAt.toISOString(),
    })),
    /**
     * ★ 页面上要写清楚这一层的边界，否则用户会把它当成
     *   「Agent 的 system prompt 文本框」来用，往里写
     *   「遇到问题自己想办法解决」之类会架空干预通道的话。
     */
    notice:
      '这里写的是**工程约定**（编码规范、测试要求、提交规范），会作为上下文下发给本项目的所有 Agent。' +
      '平台的治理规则（权限即约束、卡住要停、不得改配置）不在这里配置，也不可被覆盖。',
  };
}

export async function createConvention(
  db: Database,
  projectId: string,
  userId: string,
  input: z.infer<typeof ConventionInput>,
) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound('项目');

  const [row] = await db
    .insert(projectConventions)
    .values({
      orgId: project.orgId,
      projectId,
      title: input.title,
      content: input.content,
      appliesTo: input.appliesTo,
      priority: input.priority,
      enabled: input.enabled,
      position: input.position,
      createdBy: userId,
    })
    .returning({ id: projectConventions.id });

  return { convention: row };
}

export async function updateConvention(
  db: Database,
  conventionId: string,
  input: Partial<z.infer<typeof ConventionInput>>,
) {
  const [existing] = await db
    .select()
    .from(projectConventions)
    .where(eq(projectConventions.id, conventionId));
  if (!existing) throw notFound('工程约定');

  const [row] = await db
    .update(projectConventions)
    .set({
      ...(input.title ? { title: input.title } : {}),
      ...(input.content ? { content: input.content } : {}),
      ...(input.appliesTo ? { appliesTo: input.appliesTo } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      updatedAt: new Date(),
    })
    .where(eq(projectConventions.id, conventionId))
    .returning({ id: projectConventions.id });

  return { convention: row };
}

export async function deleteConvention(db: Database, conventionId: string) {
  const [row] = await db
    .select({ id: projectConventions.id })
    .from(projectConventions)
    .where(eq(projectConventions.id, conventionId));
  if (!row) throw notFound('工程约定');

  await db.delete(projectConventions).where(eq(projectConventions.id, conventionId));
  return { ok: true as const };
}

// ── 共用 ──────────────────────────────────────────────────────────────

function credentialColumns(credential: string | null) {
  if (credential === null) return { credentialRef: null, credentialHint: null };
  try {
    return { credentialRef: encodeSecret(credential), credentialHint: hintOf(credential) };
  } catch (err) {
    if (err instanceof SecretConfigError) throw new ApiError('VALIDATION_FAILED', err.message);
    throw err;
  }
}

function redactUrl(url: string): string {
  return url.replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***@');
}
