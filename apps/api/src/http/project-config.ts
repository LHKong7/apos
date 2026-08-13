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
  authKindOf,
  withRemoteAuth,
  inspectKnownHosts,
  inspectPrivateKey,
  probeSsh,
  SshError,
  type GitAuth,
} from '@apos/workspace-providers';
import {
  describeRef,
  encodeSecret,
  hasMasterKey,
  hintOf,
  resolveSecret,
  SecretConfigError,
} from '../modules/security/secrets';
import { ApiError, notFound } from './errors';
import { resolveDeliveryTarget } from './storage-targets';

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
  /**
   * 明文凭证或 `env:变量名`；不传 = 不改，null = 清除。
   *
   * https 远端填 token，ssh 远端填**私钥全文**（-----BEGIN … 那一整段）。
   * 两者都只以加密引用入库，接口永远读不回原值。
   */
  credential: z.string().nullable().optional(),
  /**
   * SSH 主机公钥（known_hosts 格式），如 `ssh-keyscan github.com` 的输出。
   *
   * ★ 不是秘密 —— 它本来就是拿来公开比对的那一份，所以明文存、明文回显。
   *
   * ★ 留空不等于不校验：首次连接会按 TOFU 学到主机公钥并自动固定，
   *   此后转严格校验。填在这里只是把 TOFU 的那一次窗口也关掉。
   */
  sshKnownHosts: z
    .string()
    .max(8000)
    .nullable()
    .optional()
    // ★ 用 superRefine 是为了把 inspectKnownHosts 的**具体**说法带出去；
    //   「格式不正确」这种笼统结论没法据以行动
    .superRefine((v, ctx) => {
      const problem = v ? inspectKnownHosts(v).problem : null;
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }),
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
  /**
   * 产出交货到哪个存储目标。不传 / null = 推分支（默认）。
   *
   * ★★ 这一栏兑现的是「铺料与交货两头独立可选」：从 Git 拉代码、
   *   把生成的报告投递到对象存储，是文档 §2 举的例子，而在它出现之前
   *   交货后端只能由主挂载的种类决定，这种组合表达不了。
   *
   * ★ 填了就**不推分支**了 —— 是覆盖不是追加。产出是报告而不是代码时
   *   正好合适；两样都要的话目前得跑两个任务。
   */
  deliveryTargetId: z.string().uuid().nullable().optional(),
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

  const [gitEnv, sshEnv] = await Promise.all([probeGit(), probeSsh()]);

  return {
    repositories: rows.map((r) => {
      const cred = describeRef(r.credentialRef);
      const auth = resolveAuthUsername(r.remoteUrl, r.authUsername);
      const kind = authKindOf(r.remoteUrl);
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
         * ★ 认证形态决定了配置页该显示哪些字段：token 那套
         *   （用户名占位）和 SSH 那套（私钥、主机公钥）不重叠，
         *   同时摆出来只会让人填错栏。
         */
        authKind: kind,
        /**
         * ★ 把**即将用哪个用户名占位**回显出来。
         *   这一项填错的表现是 401，而 401 的报错里没有任何东西
         *   指向它 —— 所以它必须在配置页上就看得见。
         */
        authUsername: auth.username,
        authUsernameSource: auth.source,
        authProvider: auth.provider,
        /** 主机公钥不是秘密，明文回显；空 = 还没固定，首次连接走 TOFU */
        sshKnownHosts: r.sshKnownHosts,
        sshHostKeyPinned: Boolean(r.sshKnownHosts?.trim()),
        sshHosts: inspectKnownHosts(r.sshKnownHosts ?? '').hosts,
        checkCommand: r.checkCommand,
        checkTimeoutSeconds: r.checkTimeoutSeconds,
        deliveryTargetId: r.deliveryTargetId,
        warnings: repoWarnings(r, auth, sshEnv),
      };
    }),
    /** git 环境问题要在这一页说清楚，而不是等第一次派发才炸 */
    gitAvailable: gitEnv.ok,
    gitVersion: gitEnv.version,
    gitProblem: gitEnv.problem,
    /** 同理：镜像里少装 openssh-client，ssh 形态的仓库一个都用不了 */
    sshAvailable: sshEnv.ok,
    sshProblem: sshEnv.problem,
    /**
     * ★ 直接粘贴的凭证是不是**密文**入库 —— 不是「能不能存」。
     *   没配 APOS_SECRET_KEY 照样存得下，只是明文进库，界面上如实说。
     */
    encryptsInlineSecrets: hasMasterKey(),
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
  sshEnv: { ok: boolean; problem: string | null },
): string[] {
  const out: string[] = [];
  const http = isHttpRemote(r.remoteUrl);

  if (!r.credentialRef && http) {
    out.push('未配置凭证：私有仓库会在准备工作区时克隆失败');
  }

  /**
   * ★ 自建服务最容易踩的一条：域名认不出来，占位就沿用了 GitHub 的写法，
   *   而自建 GitLab 需要 oauth2 —— 表现是 401，看不出原因。
   */
  if (r.credentialRef && http && auth.source === 'default') {
    out.push(
      `认不出这个域名，凭证用户名占位按 ${DEFAULT_AUTH_USERNAME}（GitHub 的写法）处理。` +
        '如果这是自建 GitLab 请填 oauth2，Bitbucket 填 x-token-auth，否则会 401',
    );
  }

  if (!http) {
    /**
     * ★ 没配私钥时会回退到宿主机的 ~/.ssh —— 这是历史行为，保留是对的
     *   （部署在有 SSH 配置的机器上是合法用法），但容器里通常什么都没有，
     *   表现是 `Permission denied (publickey)`，而那句报错不会提到
     *   「你没在平台上配过私钥」。
     */
    if (!r.credentialRef) {
      out.push(
        '未配置 SSH 私钥：认证会回退到宿主机的 ~/.ssh。容器化部署里通常没有这份配置，' +
          '表现为克隆时 Permission denied (publickey)',
      );
    }

    if (!sshEnv.ok) out.push(sshEnv.problem ?? 'SSH 工具链不可用');

    /**
     * ★ 还没固定主机公钥不是错误，只是首次连接有一次 TOFU 窗口。
     *   说出来是因为「什么时候会自动固定」这件事不说没人猜得到。
     */
    if (r.credentialRef && !r.sshKnownHosts?.trim()) {
      out.push(
        '尚未固定主机公钥：首次连接会按 TOFU 接受远端公钥并自动记录，此后转严格校验。' +
          '想连这一次窗口也关掉，可以用 ssh-keyscan 把主机公钥预先填进来',
      );
    }
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
      sshKnownHosts: input.sshKnownHosts?.trim() || null,
      checkCommand: input.checkCommand?.trim() || null,
      ...(input.checkTimeoutSeconds ? { checkTimeoutSeconds: input.checkTimeoutSeconds } : {}),
      deliveryTargetId: await resolveDeliveryTarget(db, orgId, input.deliveryTargetId ?? null, null),
      ...credentialColumns(input.credential ?? null, input.remoteUrl),
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
  /**
   * ★ 凭证要按**改完之后**的远端地址来验：把 https 仓库改成 ssh 地址、
   *   同时换上私钥，是一次提交里的两个字段。拿旧地址去验会把这一步判成
   *   「往 https 仓库里填了一把私钥」。
   */
  const remoteUrl = input.remoteUrl?.trim() || existing.remoteUrl;

  const [row] = await db
    .update(repositories)
    .set({
      ...(input.name ? { name: input.name } : {}),
      ...(input.remoteUrl ? { remoteUrl } : {}),
      ...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}),
      ...(input.branchPrefix !== undefined ? { branchPrefix: input.branchPrefix } : {}),
      // ★ null 与 undefined 在这里意义不同：null = 清空（回到按域名推断 /
      //   不跑核验 / 重新 TOFU），undefined = 这次没提这个字段，别动它
      ...(input.authUsername !== undefined
        ? { authUsername: input.authUsername?.trim() || null }
        : {}),
      ...(input.sshKnownHosts !== undefined
        ? { sshKnownHosts: input.sshKnownHosts?.trim() || null }
        : {}),
      ...(input.checkCommand !== undefined
        ? { checkCommand: input.checkCommand?.trim() || null }
        : {}),
      ...(input.checkTimeoutSeconds !== undefined
        ? { checkTimeoutSeconds: input.checkTimeoutSeconds }
        : {}),
      ...(input.deliveryTargetId !== undefined
        ? {
            deliveryTargetId: await resolveDeliveryTarget(
              db,
              existing.orgId,
              input.deliveryTargetId,
              null,
            ),
          }
        : {}),
      ...(credential !== undefined ? credentialColumns(credential, remoteUrl) : {}),
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

  const kind = authKindOf(repo.remoteUrl);
  const auth = resolveAuthUsername(repo.remoteUrl, repo.authUsername);
  const base = { authKind: kind, authUsername: auth.username, authUsernameSource: auth.source };

  const gitEnv = await probeGit();
  if (!gitEnv.ok) {
    return { ok: false as const, stage: 'git' as const, ...base, message: gitEnv.problem, branches: null };
  }

  /** ssh 形态先看工具链 —— 少装 openssh-client 的表现是一句认不出的 git 报错 */
  if (kind === 'ssh_key') {
    const sshEnv = await probeSsh();
    if (!sshEnv.ok) {
      return {
        ok: false as const,
        stage: 'ssh' as const,
        ...base,
        message: sshEnv.problem ?? 'SSH 工具链不可用',
        branches: null,
      };
    }
  }

  const cred = describeRef(repo.credentialRef);
  if (repo.credentialRef && !cred.usable) {
    return {
      ok: false as const,
      stage: 'credential' as const,
      ...base,
      message: cred.problem ?? '凭证不可用',
      branches: null,
    };
  }

  const pinnedBefore = Boolean(repo.sshKnownHosts?.trim());

  try {
    /**
     * ★ ssh 形态下这次探测会顺带把主机公钥固定下来（withRepoAuth 里的 TOFU）。
     *   这是有意的：在配置页上点一下就把 TOFU 那一次窗口用掉，比留到
     *   第一次派发时在无人看着的情况下用掉要好。
     */
    const branches = await withRemoteAuth(
      {
        secrets: { resolve: resolveSecret },
        hostKeys: {
          pin: async (id, knownHosts) => {
            await db
              .update(repositories)
              .set({ sshKnownHosts: knownHosts, updatedAt: new Date() })
              .where(eq(repositories.id, id));
          },
        },
      },
      {
        id: repo.id,
        ref: repo.ref,
        remoteUrl: repo.remoteUrl,
        defaultBranch: repo.defaultBranch,
        credentialRef: repo.credentialRef,
        authUsername: repo.authUsername,
        sshKnownHosts: repo.sshKnownHosts,
      },
      (auth: GitAuth | undefined) => git.lsRemoteHeads(repo.remoteUrl, auth),
    );
    const hasDefault = branches.includes(repo.defaultBranch);
    const pinnedNow = kind === 'ssh_key' && !pinnedBefore && Boolean(repo.credentialRef);

    return {
      ok: hasDefault,
      stage: hasDefault ? ('ok' as const) : ('branch' as const),
      ...base,
      branchCount: branches.length,
      /** 只回前 50 个，仓库可能有上千分支 */
      branches: branches.slice(0, 50),
      message:
        (hasDefault
          ? `连接成功，远端有 ${branches.length} 个分支`
          : `连接成功，但远端没有默认分支 ${repo.defaultBranch}。派发时会失败 —— ` +
            `可选的有：${branches.slice(0, 5).join('、')}${branches.length > 5 ? ' …' : ''}`) +
        (pinnedNow ? '\n已记录该主机的公钥，此后的连接会严格校验它。' : ''),
    };
  } catch (err) {
    /**
     * ★ SSH 认证准备阶段的失败（私钥加载不了、ssh-agent 起不来）要和
     *   「连上了但被拒」分开：前者是**这把 key 本身**的问题，改的是
     *   凭证一栏；混进 network 的话报错会指向网络，方向就错了。
     */
    if (err instanceof SshError) {
      return {
        ok: false as const,
        stage: 'ssh' as const,
        ...base,
        branches: null,
        message: err.hint ? `${err.message}：${err.hint}` : err.message,
      };
    }

    const raw = err instanceof GitError ? err.message : String(err);

    /**
     * ★★ 主机公钥对不上不是网络问题，也不是凭证问题 —— 它只有两种可能：
     *   服务器换了密钥，或者有人在中间。两者的下一步动作都很具体，
     *   而它默认会落进 network 那一档，指向完全错误的方向。
     */
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(raw)) {
      return {
        ok: false as const,
        stage: 'host_key' as const,
        ...base,
        branches: null,
        message:
          '远端的主机公钥和已固定的那份不一致。要么服务器换过密钥，要么连接被中间人接管了 —— ' +
          '请先用 `ssh-keyscan` 核对新公钥，确认无误后再更新「主机公钥」一栏（清空则会重新学习）。\n' +
          raw,
      };
    }

    /**
     * ★ 401/403 时把当前用的用户名占位一起说出来。
     *   这是整条链路上最难自己想到的一环 —— GitLab 用了 GitHub 的占位
     *   就是 401，而错误信息本身永远不会提到这件事。
     */
    const authFailed =
      /401|403|Authentication failed|not authorized|access denied|Permission denied \(publickey/i.test(
        raw,
      );

    return {
      ok: false as const,
      stage: authFailed ? ('auth' as const) : ('network' as const),
      ...base,
      branches: null,
      message: authFailed ? `${raw}\n${authAdvice(kind, repo.credentialRef, auth)}` : raw,
    };
  }
}

/** 认证失败时该往哪儿看 —— 两种形态的下一步动作完全不同 */
function authAdvice(
  kind: 'token' | 'ssh_key',
  credentialRef: string | null,
  auth: ReturnType<typeof resolveAuthUsername>,
): string {
  if (kind === 'ssh_key') {
    return credentialRef
      ? '这把私钥被远端拒绝了：确认对应的公钥已加到仓库的 Deploy keys（或账号的 SSH keys）里，且有写权限。'
      : '这个仓库没有配置 SSH 私钥，刚才用的是宿主机的 ~/.ssh —— 容器里通常没有。请在凭证一栏填入私钥全文。';
  }
  return (
    `当前使用的凭证用户名占位是 ${auth.username}（${SOURCE_LABEL[auth.source]}）。` +
    '若这是 GitLab 请填 oauth2，Bitbucket 填 x-token-auth；也可能是 token 过期或缺少仓库读写 scope。'
  );
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

function credentialColumns(credential: string | null, remoteUrl: string) {
  if (credential === null) return { credentialRef: null, credentialHint: null };

  const label = describeSshKey(remoteUrl, credential);
  try {
    return { credentialRef: encodeSecret(credential), credentialHint: hintOf(credential, label) };
  } catch (err) {
    if (err instanceof SecretConfigError) throw new ApiError('VALIDATION_FAILED', err.message);
    throw err;
  }
}

/**
 * ssh 远端的凭证在**保存那一刻**验形态，顺带产出页面上认得出的 hint。
 *
 * ★★ 带密码的私钥必须在这里拒掉。
 *
 *   它注定用不了（无人值守场景没法输入密码短语），而放进库的话失败会
 *   推迟到第一次派发，表现成一条「准备工作区失败」—— 管理员会往权限和
 *   网络上找，因为他保存的时候平台什么都没说。
 *
 * ★ 顺带也挡住了「把 token 填给 ssh 地址」这个形近错误。
 *
 * @returns hint 用的说法（`ssh 私钥（ed25519）`），不适用时 null
 */
function describeSshKey(remoteUrl: string, credential: string): string | null {
  if (isHttpRemote(remoteUrl)) return null;

  /**
   * ★ env: 形态取不到值时不拦：变量可能是部署时才注入的，
   *   现在没有不代表配错了。「环境变量未设置」这条由 describeRef 单独报。
   */
  const trimmed = credential.trim();
  const plaintext = trimmed.startsWith('env:')
    ? (process.env[trimmed.slice(4).trim()] ?? null)
    : trimmed;
  if (!plaintext) return null;

  const key = inspectPrivateKey(plaintext);
  if (key.problem) throw new ApiError('VALIDATION_FAILED', `SSH 私钥不可用：${key.problem}`);

  return key.keyType ? `ssh 私钥（${key.keyType}）` : 'ssh 私钥';
}

function redactUrl(url: string): string {
  return url.replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***@');
}
