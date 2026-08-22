import { stat } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  agents,
  projectAgentPermissions,
  projects,
  repositories,
  storageTargets,
  type Database,
} from '@apos/db';
import { S3Client, isMountRootAllowed, normalizePrefix } from '@apos/workspace-providers';
import {
  describeRef,
  encodeSecret,
  hasMasterKey,
  hintOf,
  resolveSecret,
  SecretConfigError,
} from '../modules/security/secrets';
import { localMountRootsFromEnv } from '../modules/workspace';
import { fail, notFound } from './errors';

/**
 * Storage target registrations — the non-Git workspace sources.
 *
 * ★★ Why these do not live in the `repositories` table and on that page.
 *
 *   Every column of that table is a git concept (remoteUrl / defaultBranch / branchPrefix /
 *   sshKnownHosts). Squeezing an S3 bucket in means filling those columns with placeholders,
 *   and placeholders leak all the way to the UI ("Default branch: main"). That is exactly
 *   the trap planning tasks fell into back when they pretended to be a git repository with
 *   `branch: 'planning'` (see docs/tech/11-workspace-abstraction.md §1).
 *
 * ★ `ResourceScope` references them with `kind: 'dataset'`, kept separate from a
 *   repository's `kind: 'repo'` — which makes "what was authorized" self-explanatory in a
 *   permission snapshot.
 *
 * 存储目标登记 —— 非 Git 的工作区来源。
 *
 * ★★ 为什么不塞进 `repositories` 表和那一页。
 *
 *   那张表的每一列都是 git 概念（remoteUrl / defaultBranch / branchPrefix /
 *   sshKnownHosts），一个 S3 bucket 塞进去要给这些列填占位符，而占位符会
 *   一路流到界面上（「默认分支：main」）。这正是规划任务曾经用
 *   `branch:'planning'` 假装自己是 git 仓库时踩过的坑
 *   （见 docs/tech/11-workspace-abstraction.md §1）。
 *
 * ★ `ResourceScope` 里用 `kind: 'dataset'` 引用它，与仓库的 `kind: 'repo'`
 *   分开 —— 「授权了什么」在权限快照里因此是自解释的。
 */

// ── Input ─────────────────────────────────────────────────────────────

const REF_RE = /^[a-z0-9][a-z0-9_.-]*$/i;

export const StorageTargetInput = z
  .object({
    ref: z
      .string()
      .min(1, '标识不能为空')
      .max(64)
      .regex(REF_RE, '标识只能包含字母、数字、-、_、.'),
    name: z.string().min(1).max(120),
    kind: z.enum(['object_storage', 'local']),

    // ── object_storage ──────────────────────────────────────────────
    /**
     * S3-compatible endpoint, e.g. `https://s3.us-east-1.amazonaws.com` or a self-hosted
     * MinIO address
     */
    endpoint: z.string().max(500).nullable().optional(),
    region: z.string().max(64).optional(),
    bucket: z.string().max(255).nullable().optional(),
    /** Mount only objects under this prefix; an empty string means the whole bucket */
    prefix: z.string().max(500).optional(),
    /**
     * path-style (`host/bucket/key`) versus virtual-host-style (`bucket.host/key`).
     *
     * ★ Configured explicitly rather than guessed: MinIO / Ceph / self-hosted gateways
     *   generally only support path-style, and guessing wrong shows up as a DNS resolution
     *   failure — an error that points nowhere near "addressing style".
     *
     * path-style（`host/bucket/key`）还是 virtual-host-style（`bucket.host/key`）。
     *
     * ★ 显式配置而不是猜：MinIO / Ceph / 自建网关基本只支持 path-style，
     *   而认错了的表现是 DNS 解析失败 —— 完全不指向「寻址风格」这件事。
     */
    forcePathStyle: z.boolean().optional(),

    // ── local ───────────────────────────────────────────────────────
    /** Absolute path on the host machine */
    rootPath: z.string().max(1000).nullable().optional(),

    /**
     * Object storage credential, shaped as `accessKeyId:secretAccessKey`, or `env:VAR_NAME`.
     * Omitted = unchanged, null = cleared. Only a reference is stored, and the API never
     * reads the raw value back out.
     *
     * 对象存储凭证，形如 `accessKeyId:secretAccessKey`，或 `env:变量名`。
     */
    credential: z.string().nullable().optional(),
    /**
     * Writable = the delivery stage is allowed to write back.
     *
     * ★ Defaults to false. If it defaulted to writable, a dataset mounted purely "for
     *   reference" would get written back the moment an agent casually edited a few files —
     *   something whoever registered it never intended.
     *
     * 可写 = 交货阶段允许写回。
     *
     * ★ 默认 false。默认可写的话，一个「挂进来当参考」的数据集会在
     *   Agent 顺手改了几个文件之后被写回去，而登记的人从没打算让它可写。
     */
    writable: z.boolean().optional(),
    /**
     * Which storage target the output is delivered to. Omitted = write back to itself.
     *
     * ★ Pointing elsewhere means **delivery**: only files added or modified in the change
     *   set are uploaded, they land under `{prefix}{runId}/`, and nothing in the target is
     *   ever deleted.
     *
     * 产出交货到哪个存储目标。不传 = 写回自己。
     *
     * ★ 指向别处时语义是**投递**：只上传变更集里新增/修改的文件，
     *   落在 `{前缀}{runId}/` 下，不删除目标里的任何东西。
     */
    deliveryTargetId: z.string().uuid().nullable().optional(),
    /** Omitted means organization-wide sharing */
    projectId: z.string().uuid().nullable().optional(),
  })
  /**
   * ★★ Each kind's required fields are caught at the **entrance**, not left to the database
   *   check constraint alone.
   *
   *   The constraint does stop a registration that is missing its bucket, but what comes
   *   back is a Postgres constraint name (storage_targets_shape_check), and an admin cannot
   *   tell from that which field to fill in. Here we name the field; the constraint stays as
   *   the last line of defense.
   *
   * ★★ 两类各自的必填项在**入口**就卡住，而不是只靠库里的 check 约束。
   *
   *   库约束会把缺 bucket 的登记挡下来，但报出来的是一句 Postgres 的
   *   约束名（storage_targets_shape_check），管理员看不出该补哪一栏。
   *   这里逐栏说清楚，库约束留作最后一道兜底。
   */
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    if (v.kind === 'object_storage') {
      if (!v.endpoint?.trim()) issue('endpoint', '对象存储必须填端点地址');
      else if (!/^https?:\/\//i.test(v.endpoint.trim())) {
        issue('endpoint', '端点地址必须以 http:// 或 https:// 开头');
      }
      if (!v.bucket?.trim()) issue('bucket', '对象存储必须填 bucket');
      if (v.rootPath?.trim()) issue('rootPath', '对象存储不需要本地路径');
    }

    if (v.kind === 'local') {
      const p = v.rootPath?.trim();
      if (!p) issue('rootPath', '本地目录必须填绝对路径');
      // ★ A relative path resolves against **the server process's working directory**, which
      //   is usually the code repository itself
      else if (!isAbsolute(p)) issue('rootPath', '必须是绝对路径（以 / 开头）');
      if (v.bucket?.trim() || v.endpoint?.trim()) {
        issue('bucket', '本地目录不需要端点与 bucket');
      }
    }
  });

type StorageTargetInputType = z.infer<typeof StorageTargetInput>;

// ── Reads ─────────────────────────────────────────────────────────────

export async function listStorageTargets(db: Database, orgId: string, projectId: string | null) {
  const rows = await db
    .select()
    .from(storageTargets)
    .where(
      projectId
        ? and(
            eq(storageTargets.orgId, orgId),
            or(isNull(storageTargets.projectId), eq(storageTargets.projectId, projectId)),
          )
        : eq(storageTargets.orgId, orgId),
    )
    .orderBy(asc(storageTargets.ref));

  const mountRoots = localMountRootsFromEnv();

  return {
    storageTargets: rows.map((r) => {
      const cred = describeRef(r.credentialRef);
      return {
        id: r.id,
        ref: r.ref,
        name: r.name,
        kind: r.kind,
        endpoint: r.endpoint,
        region: r.region,
        bucket: r.bucket,
        prefix: r.prefix,
        forcePathStyle: r.forcePathStyle,
        rootPath: r.rootPath,
        writable: r.writable,
        deliveryTargetId: r.deliveryTargetId,
        scope: r.projectId ? 'project' : 'organization',
        projectId: r.projectId,
        status: r.status,
        credentialHint: r.credentialHint,
        credentialUsable: cred.usable,
        credentialProblem: cred.problem,
        /** ★ The code paired with the Chinese sentence above; the UI looks up its message by it */
        credentialProblemCode: cred.problemCode,
        credentialProblemParams: cred.problemParams,
        warnings: targetWarnings(r, mountRoots),
      };
    }),
    /**
     * ★ The allowlist has to be visible on this page. It is an environment variable, so an
     *   admin cannot see it anywhere in the UI, yet it alone decides whether a registration
     *   clears the gate. Hide it and a gated registration looks exactly like a healthy one
     *   until the first dispatch reports "outside the allowed roots".
     *
     * ★ 白名单要在这一页显示出来。它是环境变量，管理员在界面上看不到，
     *   而一条登记「过没过闸」完全由它决定 —— 不显示的话，被闸掉的登记
     *   在页面上和正常的一模一样，直到第一次派发才报「不在允许范围内」。
     */
    localMountRoots: mountRoots,
    localMountRestricted: mountRoots.length > 0,
    /** Whether a pasted credential is stored encrypted — not whether it can be stored */
    encryptsInlineSecrets: hasMasterKey(),
  };
}

/**
 * Problems worth saying out loud on the configuration page.
 *
 * ★ Every one of them is the kind that otherwise waits until the first dispatch to blow up.
 *
 * 配置页上要提前说出来的问题。
 */
function targetWarnings(
  r: typeof storageTargets.$inferSelect,
  mountRoots: string[],
): string[] {
  const out: string[] = [];

  if (r.kind === 'object_storage') {
    if (!r.credentialRef) {
      out.push('未配置凭证：挂载时会因为拿不到 access key 直接失败');
    }
    /**
     * ★ The easiest one to overlook: write-back happens **from the change set**, and a
     *   read-only mount is skipped outright at the delivery stage. Register a target as
     *   read-only while expecting it to receive output and the symptom is "the task
     *   succeeded but the bucket is empty".
     *
     * ★ 这一条最容易被忽略：写回是**按变更集**做的，而只读挂载在交货阶段
     *   会原样跳过。登记成只读却指望它接收产物，表现是「任务成功但 bucket 里
     *   什么都没有」。
     */
    if (!r.writable) {
      out.push('登记为只读：Agent 的改动不会写回这个 bucket');
    }
  }

  if (r.kind === 'local') {
    if (r.rootPath && !isMountRootAllowed(r.rootPath, mountRoots)) {
      out.push(
        `这个路径不在 APOS_LOCAL_MOUNT_ROOTS 允许的范围内（${mountRoots.join('、')}），挂载会被拒绝`,
      );
    }
    if (mountRoots.length === 0) {
      out.push(
        '部署方没有配置 APOS_LOCAL_MOUNT_ROOTS，任何被登记的路径都能挂 —— ' +
          '建议在部署环境里限定允许的目录范围',
      );
    }
    if (!r.writable) out.push('登记为只读：Agent 的改动不会写回源目录');
  }

  return out;
}

// ── Writes ────────────────────────────────────────────────────────────

/**
 * A local directory must fall under one of the deployment's allowed mount roots — enforced
 * **before saving**.
 *
 * ★★ This used to be only a warning: the form was accepted, the row was written with status
 *   `active`, and the list showed a line of small print saying "the mount will be rejected".
 *   In other words, a resource the UI plainly labeled `Status: active` was guaranteed to
 *   fail on its first dispatch — and that failure (see the rejection path in dispatch) is
 *   invisible from where the user is standing. The allowed roots are printed at the top of
 *   this very page, so this is entirely decidable before the save.
 *
 * ★ The error carries a code plus params, not a pre-built sentence: the frontend renders it
 *   next to the field in the viewer's own language.
 *
 * 本地目录必须落在部署方允许的挂载根里 —— **保存前**就拦。
 *
 * ★★ 此前这条只是一句 warning：表单照收，行落库、状态写成 active，
 *   然后在列表里挂一行中文小字说「挂载会被拒绝」。也就是说，
 *   界面上明明白白写着 `Status: active` 的资源，第一次派发一定失败 ——
 *   而那次失败（见 dispatch 的拒收路径）现场是看不见的。
 *   允许的根就印在同一个页面顶上，这件事在保存前完全判得了。
 *
 * ★ 错误带码 + 参数，不是拼好的句子：前端要按语言把它显示在字段旁边。
 */
function assertMountRootAllowed(kind: string, rootPath: string | null | undefined): void {
  if (kind !== 'local' || !rootPath) return;
  const roots = localMountRootsFromEnv();
  if (roots.length === 0) return; // The deployment set no restriction
  if (isMountRootAllowed(rootPath, roots)) return;

  throw fail(
    'VALIDATION_FAILED',
    'storage.path_outside_mount_roots',
    `这个路径不在 APOS_LOCAL_MOUNT_ROOTS 允许的范围内（${roots.join('、')}）`,
    { params: { roots: roots.join('、') }, details: { code: 'path_outside_mount_roots', params: { roots: roots.join('、') }, field: 'rootPath' } },
  );
}

export async function createStorageTarget(
  db: Database,
  orgId: string,
  userId: string,
  input: StorageTargetInputType,
) {
  const existing = await db
    .select({ id: storageTargets.id })
    .from(storageTargets)
    .where(and(eq(storageTargets.orgId, orgId), eq(storageTargets.ref, input.ref)));
  if (existing.length > 0) {
    throw fail(
      'VERSION_CONFLICT',
      'storage.ref_taken',
      `标识 ${input.ref} 已被占用`,
      { params: { ref: input.ref }, details: { ref: input.ref } },
    );
  }

  /**
   * ★ Repository refs and storage target refs live in **one namespace**: an agent's resource
   *   scope resolves by (kind, ref), but a person only ever sees the ref. Let the two
   *   collide and the page shows two identically named resources, with which one a grant
   *   actually selected depending entirely on kind — an ambiguity that is nearly impossible
   *   to prove either way once something goes wrong.
   *
   * ★ 仓库与存储目标的 ref 落在**同一个命名空间**里：Agent 的资源范围
   *   靠 (kind, ref) 解析，但人只看得到一个 ref。两边撞名的话，
   *   页面上会出现两条同名资源，而授权时选中哪一条全看 kind ——
   *   这种歧义在出问题时极难自证。
   */
  await assertRefFree(db, orgId, input.ref);

  assertMountRootAllowed(input.kind, input.rootPath);

  if (input.projectId) {
    const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId));
    if (!p) throw notFound('project');
  }

  const [row] = await db
    .insert(storageTargets)
    .values({
      orgId,
      projectId: input.projectId ?? null,
      ref: input.ref,
      name: input.name,
      kind: input.kind,
      ...shapeColumns(input),
      ...(input.writable === undefined ? {} : { writable: input.writable }),
      deliveryTargetId: await resolveDeliveryTarget(db, orgId, input.deliveryTargetId ?? null, null),
      ...credentialColumns(input.credential ?? null),
      createdBy: userId,
    })
    .returning({ id: storageTargets.id, ref: storageTargets.ref });

  return { storageTarget: row };
}

export async function updateStorageTarget(
  db: Database,
  orgId: string,
  targetId: string,
  input: Partial<StorageTargetInputType> & { status?: 'active' | 'disabled' },
) {
  const existing = await loadOwned(db, orgId, targetId);

  /**
   * ★ The kind cannot be changed. The required columns of object_storage and local do not
   *   overlap at all, so a half-finished switch gets the whole update rejected by the check
   *   constraint, with an error naming the constraint instead of the field. To change kinds,
   *   delete and re-register — which also gives the "agents whose grants point at it" check
   *   a chance to run.
   *
   * ★ 不允许改 kind。object_storage 与 local 的必填列完全不重叠，
   *   改一半的话库约束会把整次更新拒掉，而报错指向的是约束名不是字段。
   *   要换类型就删了重建 —— 这也让「授权指向它的 Agent」那道检查有机会跑。
   */
  if (input.kind && input.kind !== existing.kind) {
    throw fail('VALIDATION_FAILED', 'storage.type_immutable', '不能修改存储目标的类型，请删除后重新登记');
  }

  assertMountRootAllowed(existing.kind, input.rootPath ?? existing.rootPath);

  const credential = input.credential === undefined ? undefined : input.credential?.trim() || null;

  assertShapeAfterUpdate(existing, input);

  /**
   * ★★ Before flipping a target to read-only, check whether other registrations are
   *   delivering their output into it.
   *
   *   `resolveDeliveryTarget` already rejects a read-only target at the moment a delivery
   *   target is saved, because "I configured a delivery target and the output never arrived"
   *   is the hardest failure to reason your way to. But writability can be changed
   *   **afterward** — turning it off from this end lets those registrations slip past that
   *   check: they get skipped at wrap-up, the task still succeeds, the artifacts page still
   *   has a record, and the files simply went nowhere. The delete path has guarded the same
   *   thing all along (see deleteStorageTarget); this closes the other half.
   *
   * ★★ 改成只读之前，先看有没有别的登记正把产出交货到它。
   *
   *   `resolveDeliveryTarget` 在保存交货目标那一刻拒了只读的目标，理由是
   *   「配了交货目标但产出没到」最难自己想到。可只读是**后来**也能改的 ——
   *   从这一头把它关掉，那些登记就绕过了那道检查：收尾时被跳过，
   *   任务照样成功、产物页照样有记录，只是东西哪儿都没到。
   *   删除那条路早就在挡同一件事（见 deleteStorageTarget），这里补齐。
   */
  if (input.writable === false && existing.writable) {
    const dependents = await deliveryDependents(db, targetId);
    if (dependents.length > 0) {
      throw fail(
        'VERSION_CONFLICT',
        'storage.readonly_would_drop_deliveries',
        `还有 ${dependents.length} 条登记把产出交货到 ${existing.ref}，` + `改成只读会让它们的产出静默落空：${dependents.join('、')}`,
        { params: { count: dependents.length, ref: existing.ref, dependents: dependents.join('、') }, details: { dependents } },
      );
    }
  }

  const [row] = await db
    .update(storageTargets)
    .set({
      ...(input.name ? { name: input.name } : {}),
      // ★ null and undefined mean different things here: null = clear the column,
      //   undefined = this request did not mention the field, leave it alone
      ...(input.endpoint !== undefined ? { endpoint: input.endpoint?.trim() || null } : {}),
      ...(input.region !== undefined ? { region: input.region } : {}),
      ...(input.bucket !== undefined ? { bucket: input.bucket?.trim() || null } : {}),
      ...(input.prefix !== undefined ? { prefix: input.prefix.trim() } : {}),
      ...(input.forcePathStyle !== undefined ? { forcePathStyle: input.forcePathStyle } : {}),
      ...(input.rootPath !== undefined ? { rootPath: input.rootPath?.trim() || null } : {}),
      ...(input.writable !== undefined ? { writable: input.writable } : {}),
      ...(input.deliveryTargetId !== undefined
        ? {
            deliveryTargetId: await resolveDeliveryTarget(
              db,
              existing.orgId,
              input.deliveryTargetId,
              targetId,
            ),
          }
        : {}),
      ...(credential !== undefined ? credentialColumns(credential) : {}),
      ...(input.status ? { status: input.status } : {}),
      updatedAt: new Date(),
    })
    .where(eq(storageTargets.id, targetId))
    .returning({ id: storageTargets.id });

  return { storageTarget: row };
}

export async function deleteStorageTarget(db: Database, orgId: string, targetId: string) {
  const row = await loadOwned(db, orgId, targetId);

  /**
   * ★ A target still referenced by an agent grant cannot be deleted — delete it and those
   *   agents' dataset scopes become strings that resolve to nothing, which shows up as
   *   "every dispatch suddenly fails", with the error never mentioning that someone removed
   *   a storage target. Same discipline as on the repository side.
   *
   * ★ 还有 Agent 授权指向它就不能删 —— 删掉之后那些 Agent 的 dataset 范围
   *   会变成解析不出来的字符串，表现是「派发时突然全部失败」，
   *   而错误信息里不会提到有人删了一个存储目标。与仓库那边同一条纪律。
   */
  /**
   * ★ Same as on the repository side: grants live at project level, so the reference check
   *   has to query that table too
   */
  const all = await db
    .select({ name: agents.name, scopes: projectAgentPermissions.resourceScopes })
    .from(projectAgentPermissions)
    .innerJoin(agents, eq(agents.id, projectAgentPermissions.agentId))
    .where(eq(projectAgentPermissions.orgId, row.orgId));
  const referencing = all.filter((a) =>
    a.scopes.some((s) => s.kind === 'dataset' && s.ref === row.ref && s.access !== 'none'),
  );
  if (referencing.length > 0) {
    throw fail(
      'VERSION_CONFLICT',
      'storage.referenced_by_agents',
      `还有 ${referencing.length} 个 Agent 的资源范围指向存储目标 ${row.ref}`,
      { params: { count: referencing.length, ref: row.ref }, details: { agents: referencing.map((a) => a.name) } },
    );
  }

  /**
   * ★★ A target that other registrations deliver into cannot be deleted either.
   *
   *   `delivery_target_id` deliberately has no foreign key (two tables point at the same
   *   place, so it would take two constraints, and the delete semantics are not cascade
   *   anyway), which makes this check the only gate. Without it the delete succeeds and, at
   *   the next wrap-up, those repositories' and targets' output silently falls back to "no
   *   delivery" — the task still succeeds, the artifacts page still has a record, and the
   *   files went nowhere.
   *
   * ★★ 还有登记把产出交货到它，也不能删。
   *
   *   `delivery_target_id` 刻意没有外键（跨两张表指向同一处，外键要建两条，
   *   而删除语义又不是级联），所以这道检查是唯一的把关。少了它，删除
   *   会成功，而那些仓库/目标的产出在下一次收尾时静默落回「不交货」——
   *   任务照样成功、产物页照样有记录，只是东西哪儿都没到。
   */
  const dependents = await deliveryDependents(db, targetId);
  if (dependents.length > 0) {
    throw fail(
      'VERSION_CONFLICT',
      'storage.referenced_by_deliveries',
      `还有 ${dependents.length} 条登记把产出交货到 ${row.ref}：${dependents.join('、')}`,
      { params: { count: dependents.length, ref: row.ref, dependents: dependents.join('、') }, details: { dependents } },
    );
  }

  await db.delete(storageTargets).where(eq(storageTargets.id, targetId));
  return { ok: true as const };
}

// ── Probes ────────────────────────────────────────────────────────────

/**
 * Connectivity probe.
 *
 * ★★ It exists for the same reason as the repository probe: a misconfiguration should be
 *   visible **on the configuration page**, not discovered at the first dispatch as
 *   "workspace preparation failed: mount failed" — a message that cannot distinguish a wrong
 *   endpoint from an expired credential from a missing bucket from a backwards addressing
 *   style, and those four call for completely different next steps.
 *
 * ★ Read-only: list the first few objects / stat the directory. Nothing is written, nothing
 *   touches disk.
 *
 * 连通性探测。
 *
 * ★★ 存在的理由与仓库那边的 probe 一样：配错了要在**配置页上**知道，
 *   而不是等第一次派发看到一句「准备工作区失败：挂载失败」——
 *   那条报错分不清是端点写错、凭证过期、bucket 不存在，还是寻址风格选反了，
 *   而这四种原因的下一步动作完全不同。
 *
 * ★ 只读：列举前几个对象 / stat 一下目录，不写任何东西、不落盘。
 */
export async function probeStorageTarget(db: Database, orgId: string, targetId: string) {
  const row = await loadOwned(db, orgId, targetId);

  return row.kind === 'local' ? probeLocal(row) : probeObjectStore(row);
}

type ProbeResult = {
  ok: boolean;
  stage: 'ok' | 'config' | 'credential' | 'allowlist' | 'network' | 'auth' | 'not_found';
  message: string;
  /** Number of objects/entries found; null when the probe could not look */
  objectCount: number | null;
  samples: string[];
};

async function probeLocal(row: typeof storageTargets.$inferSelect): Promise<ProbeResult> {
  const path = row.rootPath?.trim();
  if (!path) {
    return { ok: false, stage: 'config', message: '没有填写本地路径', objectCount: null, samples: [] };
  }

  const resolved = resolvePath(path);
  const roots = localMountRootsFromEnv();

  /**
   * ★ Check the allowlist first: if the path exists but is gated out, answering "the
   *   directory is there" is misleading — dispatch still will not mount it. This uses the
   *   **same** predicate function as LocalMaterializer.
   *
   * ★ 白名单先判：路径存在但被闸掉的话，只报「目录存在」是误导 ——
   *   派发时它照样挂不上。用的是与 LocalMaterializer **同一个**判据函数。
   */
  if (!isMountRootAllowed(resolved, roots)) {
    return {
      ok: false,
      stage: 'allowlist',
      message:
        `${resolved} 不在允许挂载的范围内。部署方通过 APOS_LOCAL_MOUNT_ROOTS 限定了 ` +
        `${roots.join('、')} —— 要挂这个目录，需要改部署环境的配置，改数据库没有用。`,
      objectCount: null,
      samples: [],
    };
  }

  try {
    const st = await stat(resolved);
    if (!st.isDirectory()) {
      return {
        ok: false,
        stage: 'config',
        message: `${resolved} 存在但不是目录`,
        objectCount: null,
        samples: [],
      };
    }
  } catch {
    /**
     * ★ Say so right here when the directory is missing. At mount time it shows up as "the
     *   registered local directory does not exist or is not a directory" — and by then a
     *   task has already failed once.
     *
     * ★ 目录不存在要当场说。挂载时它的表现是「登记的本地目录不存在或不是目录」，
     *   而那时任务已经失败了一次。
     */
    return {
      ok: false,
      stage: 'not_found',
      message: `${resolved} 不存在或服务进程没有权限读取它`,
      objectCount: null,
      samples: [],
    };
  }

  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(resolved).catch(() => [] as string[]);
  return {
    ok: true,
    stage: 'ok',
    message:
      `目录可读，顶层有 ${entries.length} 个条目。` +
      (row.writable
        ? '登记为可写：Agent 的改动会按变更集写回归档。'
        : '登记为只读：内容会被复制进工作区，改动不会写回。'),
    objectCount: entries.length,
    samples: entries.slice(0, 20),
  };
}

async function probeObjectStore(row: typeof storageTargets.$inferSelect): Promise<ProbeResult> {
  if (!row.endpoint || !row.bucket) {
    return { ok: false, stage: 'config', message: '缺少端点或 bucket', objectCount: null, samples: [] };
  }

  const cred = describeRef(row.credentialRef);
  if (!row.credentialRef || !cred.usable) {
    return {
      ok: false,
      stage: 'credential',
      message: cred.problem ?? '没有配置凭证，无法访问对象存储',
      objectCount: null,
      samples: [],
    };
  }

  const raw = resolveSecret(row.credentialRef);
  const sep = raw ? raw.indexOf(':') : -1;
  if (!raw || sep <= 0) {
    return {
      ok: false,
      stage: 'credential',
      message: '凭证格式应为 accessKeyId:secretAccessKey',
      objectCount: null,
      samples: [],
    };
  }

  const prefix = normalizePrefix(row.prefix);
  const client = new S3Client({
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    forcePathStyle: row.forcePathStyle,
    credentials: { accessKeyId: raw.slice(0, sep), secretAccessKey: raw.slice(sep + 1) },
  });

  try {
    // ★ One page is enough: we are verifying "can we reach it, does it accept us, does the
    //   bucket exist" — there is no reason to page to the end
    const listed = await client.list(prefix, { maxObjects: 20 });
    return {
      ok: true,
      stage: 'ok',
      message:
        `连接成功，${row.bucket}/${prefix} 下至少有 ${listed.objects.length} 个对象` +
        (listed.truncated ? '（还有更多）' : '') +
        (row.writable ? '。登记为可写：变更集会写回这个前缀。' : '。登记为只读：改动不会上传。'),
      objectCount: listed.objects.length,
      samples: listed.objects.slice(0, 20).map((o) => o.key),
    };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);

    /**
     * ★ Authentication failures and network failures are reported separately, because the
     *   next step is completely different: the former means fixing the credential, the
     *   latter means checking the endpoint address and the addressing style.
     *
     * ★ 认证失败与网络失败要分开，因为下一步动作完全不同：
     *   前者改凭证，后者查端点地址与寻址风格。
     */
    const authFailed = /403|401|SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied/i.test(text);
    if (authFailed) {
      return {
        ok: false,
        stage: 'auth',
        message: `${text}\naccess key 被拒绝：确认 key 没过期、且对 ${row.bucket} 有 ListBucket 权限。`,
        objectCount: null,
        samples: [],
      };
    }

    /**
     * ★★ A backwards addressing style shows up as a DNS resolution failure (the hostname
     *   `bucket.host` does not exist), and nothing in that error points at "addressing
     *   style". It is the most common — and the hardest to think of unaided — failure on
     *   self-hosted endpoints, so we name it explicitly here.
     *
     * ★★ 寻址风格选反了的表现是 DNS 解析失败（`bucket.host` 这个域名不存在），
     *   而那条报错里没有任何东西指向「寻址风格」。这是自建端点上最常见、
     *   也最难自己想到的一条，所以在这里点名。
     */
    const dnsFailed = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text);
    return {
      ok: false,
      stage: 'network',
      message:
        text +
        (dnsFailed && !row.forcePathStyle
          ? '\n★ 域名解析不了，而当前用的是 virtual-host 寻址（bucket.端点）。' +
            'MinIO / Ceph / 自建网关基本只支持 path-style —— 试试打开「路径风格寻址」。'
          : ''),
      objectCount: null,
      samples: [],
    };
  }
}

// ── Internals ─────────────────────────────────────────────────────────

/**
 * Who delivers output into this target — both the repositories and the storage targets table
 * have to be queried.
 *
 * ★ `delivery_target_id` deliberately has no foreign key (two tables point at the same place,
 *   so it would take two constraints, and the delete semantics are not cascade anyway),
 *   which makes this check the only gate. Deletion and "flip to read-only" share it: both
 *   edits strand the output in exactly the same way, so the verdict should not exist twice.
 *
 * 谁把产出交货到这个目标 —— 仓库与存储目标两张表都要查。
 *
 * ★ `delivery_target_id` 刻意没有外键（跨两张表指向同一处，外键要建两条，
 *   而删除语义又不是级联），所以这道检查是唯一的把关。删除与「改成只读」
 *   共用它：两种改法让产出落空的方式一模一样，判据不该有两份。
 */
async function deliveryDependents(db: Database, targetId: string): Promise<string[]> {
  const [repoDeps, targetDeps] = await Promise.all([
    db
      .select({ ref: repositories.ref })
      .from(repositories)
      .where(eq(repositories.deliveryTargetId, targetId)),
    db
      .select({ ref: storageTargets.ref })
      .from(storageTargets)
      .where(eq(storageTargets.deliveryTargetId, targetId)),
  ]);
  return [...repoDeps, ...targetDeps].map((d) => d.ref);
}

/**
 * Whether the registration still holds together after a partial update.
 *
 * ★★ The superRefine on the input schema is **switched off** for PATCH (the route uses
 *   `innerType().partial()`; the reasoning is in routes.ts — cross-field validation only
 *   holds for complete input). The price is that an edit like "clear the bucket" travels all
 *   the way to the database, gets rejected by the check constraint, and comes back to the
 *   caller as `storage_targets_shape_check` — precisely what the comment at the top of this
 *   file says to avoid, because an admin cannot tell which field to fill in.
 *
 * ★ So we judge the **post-update** shape once more here, restricted to required fields
 *   (kind is immutable and already blocked above), naming the specific field. The database
 *   constraint stays as the fallback.
 *
 * 局部更新之后，这条登记还立不立得住。
 *
 * ★★ 登记入口那层 superRefine 在 PATCH 上是**关掉的**（路由用
 *   `innerType().partial()`，理由见 routes.ts：交叉校验只对完整输入成立）。
 *   代价是「把 bucket 清空」这类改动一路走到库里，被 check 约束拒掉，
 *   而抛回调用方的是一句 `storage_targets_shape_check` —— 正是这个文件
 *   开头那段注释说要避免的东西：管理员看不出该补哪一栏。
 *
 * ★ 所以在这里按**改完之后**的形态再判一次，只判必填项这一条
 *   （kind 不可改，已在上面挡掉），逐栏说清楚。库约束仍留作兜底。
 */
function assertShapeAfterUpdate(
  existing: typeof storageTargets.$inferSelect,
  input: Partial<StorageTargetInputType>,
) {
  /** undefined = this request did not mention the field, so keep the stored value */
  const after = (field: 'endpoint' | 'bucket' | 'rootPath') =>
    input[field] === undefined ? existing[field] : (input[field]?.trim() ?? null);

  if (existing.kind === 'object_storage') {
    if (!after('endpoint')) throw fail(
      'VALIDATION_FAILED',
      'storage.object_store_needs_endpoint',
      '对象存储必须填端点地址',
    );
    if (!after('bucket')) throw fail(
      'VALIDATION_FAILED',
      'storage.object_store_needs_bucket',
      '对象存储必须填 bucket',
    );
  } else if (!after('rootPath')) {
    throw fail('VALIDATION_FAILED', 'storage.local_needs_absolute_path', '本地目录必须填绝对路径');
  }

  // ★ A relative path resolves against the server process's working directory, which is
  //   usually the code repository itself
  const root = input.rootPath?.trim();
  if (existing.kind === 'local' && root && !isAbsolute(root)) {
    throw fail('VALIDATION_FAILED', 'storage.path_must_be_absolute', '必须是绝对路径（以 / 开头）');
  }
}

/**
 * Load one registration by id, **and** require that it belongs to the caller's organization.
 *
 * ★★ The organization boundary has to be narrowed at this layer; the rbac gate cannot cover
 *   routes like these.
 *
 *   `rbac.guard()` only resolves ownership for `/api/v1/projects/:id/…` and the resource
 *   kinds on RESOURCE_SCOPED_URL (see the two patterns in rbac.ts), and `/api/v1/admin/…`
 *   matches neither — so all it can decide is "does the caller hold storage_target.manage
 *   **in their own current organization**", not "does this registration belong to their
 *   organization". Self-service signup is on by default, and signing up makes you org_admin
 *   of a fresh organization, which hands you that permission for free: without this
 *   narrowing, anyone holding a UUID could probe, tamper with, or delete another tenant's
 *   registration. Probing would list objects using **their** credentials, and tampering with
 *   the endpoint would redirect their future output into the attacker's own bucket.
 *
 *   The project path states the same discipline explicitly (rbac.ts `assertProjectAccess`:
 *   cross-organization is refused — an admin's "everything" stops at the organization
 *   boundary); this just closes the remaining gap.
 *
 * ★ Out-of-tenant access always returns 404, never 403: a 403 confirms "this id exists",
 *   which turns ids into an enumerable probe. Same choice as assertProjectAccess.
 *
 * 按 id 取一条登记，**并且**要求它属于调用者的组织。
 *
 * ★★ 组织边界必须在这一层收窄，rbac 那道闸拦不住这类路由。
 *
 *   `rbac.guard()` 只对 `/api/v1/projects/:id/…` 与 RESOURCE_SCOPED_URL 上
 *   那几种资源解析归属（见 rbac.ts 的两条正则），`/api/v1/admin/…` 两条都不匹配 ——
 *   于是它能判的只有「调用者在**自己当前组织**里有没有 storage_target.manage」，
 *   判不了「这条登记是不是他们组织的」。而自助注册默认开着，注册即是新组织的
 *   org_admin，也就天然握着这个权限：少了这道收窄，任何人拿一个 UUID 就能
 *   探测、篡改、删除别的租户的登记。探测会拿着**对方的**凭证列出对象，
 *   而篡改 endpoint 能把对方后续的产出投递引到自己的 bucket 里。
 *
 *   项目那条路上同一条纪律是显式写着的（rbac.ts `assertProjectAccess`:
 *   「跨组织的不行 —— 管理员的『全部』以组织为界」），这里只是把它补齐。
 *
 * ★ 越界一律回 404 而不是 403：403 等于确认「这个 id 存在」，
 *   把 id 变成可枚举的探针。与 assertProjectAccess 的选择一致。
 */
async function loadOwned(db: Database, orgId: string, targetId: string) {
  const [row] = await db
    .select()
    .from(storageTargets)
    .where(and(eq(storageTargets.id, targetId), eq(storageTargets.orgId, orgId)));
  if (!row) throw notFound('storage_target');
  return row;
}

/** 按 kind 只写属于它的那几列，另一类的列一律留空 */
function shapeColumns(input: StorageTargetInputType) {
  if (input.kind === 'object_storage') {
    return {
      endpoint: input.endpoint?.trim() ?? null,
      ...(input.region ? { region: input.region } : {}),
      bucket: input.bucket?.trim() ?? null,
      ...(input.prefix !== undefined ? { prefix: input.prefix.trim() } : {}),
      ...(input.forcePathStyle !== undefined ? { forcePathStyle: input.forcePathStyle } : {}),
      rootPath: null,
    };
  }
  return { endpoint: null, bucket: null, rootPath: input.rootPath?.trim() ?? null };
}

function credentialColumns(credential: string | null) {
  if (credential === null) return { credentialRef: null, credentialHint: null };
  try {
    return { credentialRef: encodeSecret(credential), credentialHint: hintOf(credential, '对象存储凭证') };
  } catch (err) {
    if (err instanceof SecretConfigError) throw fail(
      'VALIDATION_FAILED',
      err.reason,
      err.message,
      { params: err.params },
    );
    throw err;
  }
}

/**
 * 校验交货目标。
 *
 * ★★ 在**保存那一刻**验，而不是等收尾。
 *
 *   收尾时才发现目标不存在 / 只读，代价是这次 Run 的产出没了去处 ——
 *   而它是在任务跑完之后才暴露的，那时工作区已经在回收路上。
 *
 * ★ 只读的目标现在就拒：它在收尾时会被跳过，而「配了交货目标但产出
 *   没到」是最难自己想到的一种失败。
 *
 * @param selfId 更新自身时传，用来挡「投递给自己」这种绕圈配置
 */
export async function resolveDeliveryTarget(
  db: Database,
  orgId: string,
  targetId: string | null,
  selfId: string | null,
): Promise<string | null> {
  if (!targetId) return null;
  if (selfId && targetId === selfId) {
    throw fail('VALIDATION_FAILED', 'storage.delivery_target_self', '交货目标不能是它自己');
  }

  const [target] = await db
    .select()
    .from(storageTargets)
    .where(and(eq(storageTargets.id, targetId), eq(storageTargets.orgId, orgId)));

  if (!target) throw fail(
    'VALIDATION_FAILED',
    'storage.delivery_target_missing',
    '交货目标不存在，或不属于这个组织',
  );
  if (target.status !== 'active') {
    throw fail(
      'VALIDATION_FAILED',
      'storage.delivery_target_disabled',
      `交货目标 ${target.ref} 已停用`,
      { params: { ref: target.ref } },
    );
  }
  if (!target.writable) {
    throw fail(
      'VALIDATION_FAILED',
      'storage.delivery_target_readonly',
      `交货目标 ${target.ref} 登记为只读，收尾时会跳过写回 —— 请先把它改成可写`,
      { params: { ref: target.ref } },
    );
  }
  return target.id;
}

/** 与仓库共用一个 ref 命名空间 —— 撞名在授权界面上是分不清的两条同名资源 */
async function assertRefFree(db: Database, orgId: string, ref: string) {
  const [repo] = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.orgId, orgId), eq(repositories.ref, ref)));
  if (repo) {
    throw fail(
      'VERSION_CONFLICT',
      'storage.ref_taken_by_repository',
      `标识 ${ref} 已被一个代码仓库占用`,
      { params: { ref }, details: { ref } },
    );
  }
}
