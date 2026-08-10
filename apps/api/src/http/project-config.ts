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
import {
  DEFAULT_AUTH_USERNAME,
  git,
  GitError,
  isHttpRemote,
  probeGit,
  resolveAuthUsername,
} from '../modules/workspace/git';
import { gitAuthFor } from '../modules/workspace/credentials';
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
  /**
   * HTTPS token 的 Basic 用户名占位。留空 = 按域名推断
   * （GitHub → x-access-token、GitLab → oauth2、Bitbucket → x-token-auth）。
   *
   * ★ 自建 GitLab 装在 git.acme.com 上推断不出来，必须显式填 `oauth2`。
   */
  authUsername: z.string().max(120).nullable().optional(),
  /**
   * 质量核验命令，如 `pnpm test`。Agent 收工后、提交之前在工作区执行。
   *
   * ★★ 这是 reviewing 阶段唯一的**真实**测试数据源 —— 没有它，
   *   `qualityGatePassed` 这道门禁只能靠「Agent 说它跑过测试了」，
   *   而那是一句自述不是证据。
   *
   * ★ 它是在服务端 shell 里执行的任意命令，所以配置权限就是
   *   `repository.manage`（组织管理员），和登记仓库同一档 ——
   *   能登记仓库的人本来就能让 Agent 往里写代码，不设更高的门槛。
   */
  checkCommand: z.string().max(500).nullable().optional(),
  checkTimeoutSeconds: z.number().int().min(10).max(7200).optional(),
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

  const gitEnv = await probeGit();

  return {
    repositories: rows.map((r) => {
      const cred = describeRef(r.credentialRef);
      const auth = resolveAuthUsername(r.remoteUrl, r.authUsername);
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
        /**
         * ★ 把**即将用哪个用户名占位**回显出来。
         *   这一项填错的表现是 401，而 401 的报错里没有任何东西
         *   指向它 —— 所以它必须在配置页上就看得见。
         */
        authUsername: auth.username,
        authUsernameSource: auth.source,
        authProvider: auth.provider,
        checkCommand: r.checkCommand,
        checkTimeoutSeconds: r.checkTimeoutSeconds,
        warnings: repoWarnings(r, auth),
      };
    }),
    /** git 环境问题要在这一页说清楚，而不是等第一次派发才炸 */
    gitAvailable: gitEnv.ok,
    gitVersion: gitEnv.version,
    gitProblem: gitEnv.problem,
    canStoreInlineCredential: hasMasterKey(),
  };
}

/**
 * 配置页上要提前说出来的问题。
 *
 * ★ 每一条都是「不说的话要等第一次派发才炸」的那种，而那时的错误信息
 *   （clone 失败 / 401 / 没有产物）都不指向真实原因。
 */
function repoWarnings(
  r: typeof repositories.$inferSelect,
  auth: ReturnType<typeof resolveAuthUsername>,
): string[] {
  const out: string[] = [];

  if (!r.credentialRef && isHttpRemote(r.remoteUrl)) {
    out.push('未配置凭证：私有仓库会在准备工作区时克隆失败');
  }

  /**
   * ★ 自建服务最容易踩的一条：域名认不出来，占位就沿用了 GitHub 的写法，
   *   而自建 GitLab 需要 oauth2 —— 表现是 401，看不出原因。
   */
  if (r.credentialRef && isHttpRemote(r.remoteUrl) && auth.source === 'default') {
    out.push(
      `认不出这个域名，凭证用户名占位按 ${DEFAULT_AUTH_USERNAME}（GitHub 的写法）处理。` +
        '如果这是自建 GitLab 请填 oauth2，Bitbucket 填 x-token-auth，否则会 401',
    );
  }

  // token 对 ssh 地址没有意义，配了也不会被用上
  if (r.credentialRef && !isHttpRemote(r.remoteUrl)) {
    out.push('ssh 地址不使用这里配置的凭证：认证走宿主机的 SSH 配置，平台不管理 SSH key');
  }

  /**
   * ★ 没有核验命令时 reviewing 阶段的质量门禁只剩 Agent 自述 ——
   *   这一条不是可选的锦上添花，是「门禁到底有没有数据」。
   */
  if (!r.checkCommand) {
    out.push('未配置质量核验命令：reviewing 阶段的门禁将只能依据 Agent 自述，没有真实测试结果');
  }

  return out;
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
      authUsername: input.authUsername?.trim() || null,
      checkCommand: input.checkCommand?.trim() || null,
      ...(input.checkTimeoutSeconds ? { checkTimeoutSeconds: input.checkTimeoutSeconds } : {}),
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
      // ★ null 与 undefined 在这里意义不同：null = 清空（回到按域名推断 /
      //   不跑核验），undefined = 这次没提这个字段，别动它
      ...(input.authUsername !== undefined
        ? { authUsername: input.authUsername?.trim() || null }
        : {}),
      ...(input.checkCommand !== undefined
        ? { checkCommand: input.checkCommand?.trim() || null }
        : {}),
      ...(input.checkTimeoutSeconds !== undefined
        ? { checkTimeoutSeconds: input.checkTimeoutSeconds }
        : {}),
      ...(credential !== undefined ? credentialColumns(credential) : {}),
      ...(input.status ? { status: input.status } : {}),
      updatedAt: new Date(),
    })
    .where(eq(repositories.id, repoId))
    .returning({ id: repositories.id });

  return { repository: row };
}

/**
 * 连通性探测：`git ls-remote --heads`。
 *
 * ★★ 这个端点存在的理由，就是「凭证配错了要在配置页上知道，
 *   而不是等第一次派发」。
 *
 *   在此之前唯一的验证方式是派一个任务，然后看它以
 *   「准备工作区失败：git clone 失败：… 401」告终 —— 那条报错里
 *   没有任何东西能告诉你到底是 token 过期、scope 不够，
 *   还是用户名占位不对。这三种原因的下一步动作完全不同。
 *
 * ★ 用 ls-remote 不用 clone：要验的三件事（域名通不通、凭证对不对、
 *   默认分支在不在）它全能答，而且是秒级 —— clone 一个大仓库要几分钟，
 *   贵到没人愿意点第二次的检查等于没有检查。
 *
 * ★ 只读，不落盘，不建镜像。
 */
export async function probeRepository(db: Database, repoId: string) {
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, repoId));
  if (!repo) throw notFound('仓库');

  const gitEnv = await probeGit();
  if (!gitEnv.ok) {
    return { ok: false as const, stage: 'git' as const, message: gitEnv.problem, branches: null };
  }

  const auth = resolveAuthUsername(repo.remoteUrl, repo.authUsername);
  const cred = describeRef(repo.credentialRef);
  if (repo.credentialRef && !cred.usable) {
    return {
      ok: false as const,
      stage: 'credential' as const,
      message: cred.problem ?? '凭证不可用',
      authUsername: auth.username,
      branches: null,
    };
  }

  try {
    const branches = await git.lsRemoteHeads(repo.remoteUrl, gitAuthFor(repo));
    const hasDefault = branches.includes(repo.defaultBranch);

    return {
      ok: hasDefault,
      stage: hasDefault ? ('ok' as const) : ('branch' as const),
      authUsername: auth.username,
      authUsernameSource: auth.source,
      branchCount: branches.length,
      /** 只回前 50 个，仓库可能有上千分支 */
      branches: branches.slice(0, 50),
      message: hasDefault
        ? `连接成功，远端有 ${branches.length} 个分支`
        : `连接成功，但远端没有默认分支 ${repo.defaultBranch}。派发时会失败 —— ` +
          `可选的有：${branches.slice(0, 5).join('、')}${branches.length > 5 ? ' …' : ''}`,
    };
  } catch (err) {
    /**
     * ★ 401/403 时把当前用的用户名占位一起说出来。
     *   这是整条链路上最难自己想到的一环 —— GitLab 用了 GitHub 的占位
     *   就是 401，而错误信息本身永远不会提到这件事。
     */
    const raw = err instanceof GitError ? err.message : String(err);
    const authFailed = /401|403|Authentication failed|not authorized|access denied/i.test(raw);

    return {
      ok: false as const,
      stage: authFailed ? ('auth' as const) : ('network' as const),
      authUsername: auth.username,
      authUsernameSource: auth.source,
      branches: null,
      message: authFailed
        ? `${raw}\n当前使用的凭证用户名占位是 ${auth.username}（${SOURCE_LABEL[auth.source]}）。` +
          '若这是 GitLab 请填 oauth2，Bitbucket 填 x-token-auth；也可能是 token 过期或缺少仓库读写 scope。'
        : raw,
    };
  }
}

const SOURCE_LABEL: Record<'explicit' | 'host' | 'default', string> = {
  explicit: '你显式指定的',
  host: '按域名推断',
  default: '兜底默认值',
};

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
