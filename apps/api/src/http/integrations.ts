import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  integrationObjectLinks,
  integrationSyncMappings,
  integrations,
  projects,
  syncConflictRules,
  syncConflicts,
  workItems,
  type Database,
} from '@apos/db';
import {
  CATEGORY_LABELS,
  DEFAULT_NOTIFICATION_CONFIG,
  FIELD_DEFAULTS,
  NEVER_GRANTED_SCOPES,
  NOTIFY_EVENTS,
  PROVIDER_CATEGORY,
  PROVIDER_LABELS,
  SOT_PRESETS,
  STRATEGY_LABELS,
  STRATEGY_LABELS_EN,
  SYNC_FIELD_LABELS,
  SYNC_FIELD_LABELS_EN,
  type IntegrationProvider,
  type NotificationConfig,
  type SideSnapshot,
  type SyncField,
  type SyncMapping,
} from '@apos/contracts';
import {
  conflictHotspots,
  defaultMappings,
  matchPreset,
  similarityKey,
} from '@apos/domain';
import {
  nextSyncedValues,
  originTagFor,
  planSync,
  type IntegrationRegistry,
  type SyncContext,
} from '@apos/integrations';
import { mergeTypeDataNested } from '../modules/work-item/json-merge';
import { fail, notFound } from './errors';

/**
 * Integration settings (page doc 14) / 集成设置（页面文档 14）。
 *
 * ★ The entire value of this page is in being explicit: what is connected, what
 *   syncs, who wins a disagreement, and what the integration is not allowed to do.
 *   That is why every block the API returns carries explanatory text instead of a
 *   pile of enums the client would have to narrate on its own.
 *
 *   这一页的价值全在「说清楚」上：连了什么、同步什么、谁说了算、不能做什么。
 *   所以接口返回的每一块都带解释性文字，而不是只给一堆 enum 让前端自己编。
 *
 * ★ Credentials never appear in any response (page doc 14 §9). `credentialRef`
 *   points into secret management; the API returns only `credentialHint` — the last
 *   four characters. In a system where a token can be read back out of an endpoint,
 *   sooner or later somebody pastes it into a log line or a screenshot.
 *
 *   凭证从不出现在任何响应里（页面文档 14 §9）。`credentialRef` 指向密钥管理，
 *   接口只回 `credentialHint`（后四位）。一个能从接口读出 token 的系统，
 *   早晚会有人把它贴进日志或截图。
 */

export async function listIntegrations(
  db: Database,
  registry: IntegrationRegistry,
  projectId: string,
) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound('project');

  const rows = await db
    .select()
    .from(integrations)
    .where(eq(integrations.projectId, projectId))
    .orderBy(integrations.createdAt);

  const ids = rows.map((r) => r.id);
  const mappings =
    ids.length > 0
      ? await db
          .select()
          .from(integrationSyncMappings)
          .where(inArray(integrationSyncMappings.integrationId, ids))
      : [];

  const pending =
    ids.length > 0
      ? await db
          .select()
          .from(syncConflicts)
          .where(
            and(inArray(syncConflicts.integrationId, ids), eq(syncConflicts.status, 'pending')),
          )
      : [];

  const autoRules =
    ids.length > 0
      ? await db
          .select()
          .from(syncConflictRules)
          .where(inArray(syncConflictRules.integrationId, ids))
      : [];

  const links =
    ids.length > 0
      ? await db
          .select()
          .from(integrationObjectLinks)
          .where(inArray(integrationObjectLinks.integrationId, ids))
      : [];

  const list = rows.map((r) => {
    const own = mappings.filter((m) => m.integrationId === r.id);
    const conflicts = pending.filter((c) => c.integrationId === r.id);
    const provider = r.provider as IntegrationProvider;

    const syncMappings: SyncMapping[] =
      own.length > 0
        ? own.map((m) => ({
            field: m.field as SyncField,
            sourceOfTruth: m.sourceOfTruth as SyncMapping['sourceOfTruth'],
            strategy: m.strategy as SyncMapping['strategy'],
          }))
        : [];

    return {
      id: r.id,
      provider,
      providerLabel: PROVIDER_LABELS[provider] ?? provider,
      category: r.category,
      categoryLabel: CATEGORY_LABELS[r.category as keyof typeof CATEGORY_LABELS] ?? r.category,
      displayName: r.displayName,
      config: r.config,
      status: r.status,
      statusReason: r.statusReason,
      lastSyncAt: r.lastSyncAt?.toISOString() ?? null,

      /**
       * ★ Last four characters only. This field exists so a user can tell which key
       *   this is, not so they can read the key itself.
       *   只回后四位 —— 让用户认出「是哪一把钥匙」，不是让他读出钥匙本身。
       */
      credentialHint: r.credentialHint,
      credentialExpiresAt: r.credentialExpiresAt?.toISOString() ?? null,
      /** Warn 7 days before the token expires (§7) */
      credentialExpiringSoon: expiringSoon(r.credentialExpiresAt),

      /**
       * ★ Both the granted scopes and the never-granted ones go out. What a user
       *   actually needs to confirm is usually what the integration *cannot* do.
       *   允许项与禁止项都给。用户要确认的常常是「它不能做什么」
       */
      scopes: r.scopes,
      /** Scopes this provider's integration layer never grants, whatever was authorized */
      neverGranted: [...(NEVER_GRANTED_SCOPES[provider] ?? [])],

      /**
       * No registered adapter means this connection cannot sync right now — a
       * different thing from "it is misconfigured", and worth saying separately.
       * 适配器没注册 = 这个连接现在同步不了，和「配置错了」是两回事
       */
      transportReady: registry.has(provider),

      syncMappings: syncMappings.map(describeMapping),
      sotPreset: syncMappings.length > 0 ? matchPreset(syncMappings) : null,
      autoRules: autoRules
        .filter((a) => a.integrationId === r.id)
        .map((a) => ({
          field: a.field,
          fieldLabel: SYNC_FIELD_LABELS[a.field as SyncField] ?? a.field,
          fieldLabelEn: SYNC_FIELD_LABELS_EN[a.field as SyncField] ?? a.field,
          winner: a.winner,
        })),

      conflictCount: conflicts.length,
      linkedItems: links.filter((l) => l.integrationId === r.id).length,
      notificationConfig: r.notificationConfig as NotificationConfig | null,
      stats: r.stats,
    };
  });

  const allConflicts = pending.map((c) => ({ field: c.field as SyncField }));

  return {
    integrations: list,
    /** §7: the page shows a top-of-screen warning once the backlog exceeds 10 */
    conflictBacklog: pending.length,
    hotspots: conflictHotspots(allConflicts).map((h) => ({
      ...h,
      fieldLabel: SYNC_FIELD_LABELS[h.field] ?? h.field,
    })),
    /** Providers that can be added but are not connected yet */
    available: (Object.keys(PROVIDER_LABELS) as IntegrationProvider[])
      .filter((p) => !rows.some((r) => r.provider === p))
      .map((p) => ({
        provider: p,
        label: PROVIDER_LABELS[p],
        category: PROVIDER_CATEGORY[p],
        categoryLabel: CATEGORY_LABELS[PROVIDER_CATEGORY[p]],
        transportReady: registry.has(p),
      })),
    /**
     * ★ Both languages go out and the client picks (useSpecText in lib/i18n).
     *   The server has no idea which locale the caller is showing; guessing
     *   produces "I switched language but this page's field names did not".
     *
     *   中英一起给，由前端按当前语言挑（lib/i18n 的 useSpecText）。服务端
     *   不知道调用方的界面语言 —— 让它猜的结果是「切了语言，这一页的字段名
     *   还是原来那套」。
     */
    fieldCatalog: (Object.keys(FIELD_DEFAULTS) as SyncField[]).map((f) => ({
      field: f,
      label: SYNC_FIELD_LABELS[f],
      labelEn: SYNC_FIELD_LABELS_EN[f],
      ...FIELD_DEFAULTS[f],
    })),
    presets: Object.entries(SOT_PRESETS).map(([key, p]) => ({
      key,
      label: p.label,
      labelEn: p.labelEn,
      description: p.description,
      descriptionEn: p.descriptionEn,
    })),
    strategyLabels: STRATEGY_LABELS,
    strategyLabelsEn: STRATEGY_LABELS_EN,
    notifyEvents: NOTIFY_EVENTS.map((e) => ({ ...e })),
  };
}

/**
 * ★ Both languages are returned and the client picks; same reason as fieldCatalog.
 *   中英一起返回，前端按当前语言挑。理由同 fieldCatalog。
 */
function describeMapping(m: SyncMapping) {
  return {
    ...m,
    fieldLabel: SYNC_FIELD_LABELS[m.field],
    fieldLabelEn: SYNC_FIELD_LABELS_EN[m.field],
    why: FIELD_DEFAULTS[m.field].why,
    whyEn: FIELD_DEFAULTS[m.field].whyEn,
    options: FIELD_DEFAULTS[m.field].options,
    strategyLabel: STRATEGY_LABELS[m.strategy],
    strategyLabelEn: STRATEGY_LABELS_EN[m.strategy],
    /**
     * Flag anything that deviates from the default: what a user changed should
     * be obvious the next time this page is read.
     * 偏离默认值要标出来 —— 用户改过的地方，下次读这一页时该一眼看见。
     */
    customized: m.sourceOfTruth !== FIELD_DEFAULTS[m.field].sourceOfTruth,
  };
}

/**
 * Warn when a credential expires within 7 days (page doc 14 §7).
 * 7 天内过期就提示（页面文档 14 §7）。
 */
function expiringSoon(at: Date | null): boolean {
  if (!at) return false;
  return at.getTime() - Date.now() < 7 * 24 * 3600_000;
}

export async function createIntegration(
  db: Database,
  registry: IntegrationRegistry,
  input: {
    projectId: string;
    provider: IntegrationProvider;
    displayName: string;
    config: Record<string, unknown>;
    /** The plaintext exists only here; it becomes a reference before anything is stored */
    credential: string | null;
    userId: string;
  },
) {
  const [project] = await db.select().from(projects).where(eq(projects.id, input.projectId));
  if (!project) throw notFound('project');

  const [dup] = await db
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.projectId, input.projectId),
        eq(integrations.provider, input.provider),
      ),
    );
  if (dup) {
    throw fail(
      'VALIDATION_FAILED',
      'integration.provider_already_connected',
      `该项目已连接 ${PROVIDER_LABELS[input.provider]}。同一项目同一系统只能连一个对象，否则同步目标含混`,
      { params: { provider: input.provider }, details: { existingId: dup.id } },
    );
  }

  if (!registry.has(input.provider)) {
    throw fail(
      'UNSUPPORTED_FEATURE',
      'integration.transport_not_implemented',
      `${PROVIDER_LABELS[input.provider]} 的传输层还没有实现，现在连上也同步不了`,
      { params: { provider: input.provider }, details: { provider: input.provider } },
    );
  }

  const adapter = registry.get(input.provider);
  const conn = { config: input.config, credentialRef: refOf(input.credential) };

  const test = await adapter.testConnection(conn);
  if (!test.ok) {
    throw fail(
      'EXTERNAL_ERROR',
      'integration.connection_test_failed',
      `连接测试失败：${test.message}`,
      { params: { detail: test.message }, details: { provider: input.provider, } },
    );
  }

  const scopes = await adapter.grantedScopes(conn);

  /**
   * ★ Re-check the granted scopes here; do not simply trust the `allowed` list an
   *   adapter hands back. If an adapter has a bug, or the external system handed out
   *   more than was asked for, this is where it gets stopped. "Merging a PR must go
   *   through Policy evaluation" is a product-level constraint, and it cannot depend
   *   on every adapter author remembering it.
   *
   *   授权结果要复核一遍，不能只信适配器返回的 allowed。适配器实现有 bug，
   *   或者外部系统给多了权限，这里必须挡住 —— 「合并 PR 应当经过 Policy 判定」
   *   是产品级约束，不该指望每个适配器作者都记得。
   */
  const forbidden = scopes.allowed.filter((s: string) =>
    (NEVER_GRANTED_SCOPES[input.provider] ?? []).includes(s),
  );
  if (forbidden.length > 0) {
    throw fail(
      'FORBIDDEN',
      'integration.forbidden_scopes',
      `授权包含不允许的权限：${forbidden.join('、')}。这类操作必须经过 Policy 判定，不能由集成层直接放开`,
      { params: { scopes: forbidden.join(', ') }, details: { forbidden } },
    );
  }

  const category = PROVIDER_CATEGORY[input.provider];

  const [row] = await db
    .insert(integrations)
    .values({
      orgId: project.orgId,
      projectId: input.projectId,
      provider: input.provider,
      category,
      /**
       * ★ The name the user typed wins. The name an adapter probes for is only a
       *   fallback for when they left it empty. The other way around, a user's
       *   "ORDER (Scrum Board)" gets overwritten by whatever technical name the
       *   adapter returns, and the page no longer identifies which connection this is.
       *
       *   用户填的名字优先，适配器探测到的名字只在用户没填时兜底。
       */
      displayName: input.displayName.trim() || (test.displayName ?? input.provider),
      config: input.config,
      credentialRef: refOf(input.credential),
      // Last four characters only; the raw value never reaches the database
      credentialHint: hintOf(input.credential),
      scopes,
      status: 'active',
      notificationConfig:
        category === 'communication'
          ? (DEFAULT_NOTIFICATION_CONFIG as unknown as Record<string, unknown>)
          : null,
      createdBy: input.userId,
    })
    .returning();

  if (!row) throw new Error('集成创建失败');

  // Only project-management integrations need SoT config; communication and code
  // kinds take no part in field sync
  if (category === 'project_management') {
    await db.insert(integrationSyncMappings).values(
      defaultMappings().map((m) => ({
        integrationId: row.id,
        field: m.field,
        sourceOfTruth: m.sourceOfTruth,
        strategy: m.strategy,
        updatedBy: input.userId,
      })),
    );
  }

  return { id: row.id, displayName: row.displayName, scopes: row.scopes };
}

/**
 * Change the Source-of-Truth configuration / 改 SoT 配置。
 *
 * ★ This is flagged as "critical configuration" (the badge in page doc 14 §4)
 *   because it decides whose edits get thrown away from here on. So every change
 *   writes an event and the caller supplies the actor — when data turns out to
 *   disagree, someone has to be able to find out who changed this, and when.
 *
 *   这是「关键配置」（页面文档 14 §4 的角标），因为它决定以后哪一边的修改会被
 *   丢掉。所以每次修改都写事件，由调用方带上 actor —— 数据不一致时要查得出是谁
 *   在什么时候改的。
 */
export async function updateSyncMapping(
  db: Database,
  integrationId: string,
  changes: SyncMapping[],
  userId: string,
) {
  const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
  if (!row) throw notFound('integration');

  const before = await db
    .select()
    .from(integrationSyncMappings)
    .where(eq(integrationSyncMappings.integrationId, integrationId));
  const beforeBy = new Map(before.map((b) => [b.field, b]));

  const diffs: { field: SyncField; from: string; to: string }[] = [];

  for (const c of changes) {
    const options = FIELD_DEFAULTS[c.field].options;
    if (!options.includes(c.sourceOfTruth)) {
      throw fail(
        'VALIDATION_FAILED',
        'integration.field_source_unsupported',
        `「${SYNC_FIELD_LABELS[c.field]}」不支持以${c.sourceOfTruth === 'apos' ? ' APOS ' : '外部系统'}为准：${FIELD_DEFAULTS[c.field].why}`,
        { params: { field: c.field, side: c.sourceOfTruth }, details: { field: c.field, options } },
      );
    }

    const prev = beforeBy.get(c.field);
    if (prev && prev.sourceOfTruth !== c.sourceOfTruth) {
      diffs.push({ field: c.field, from: prev.sourceOfTruth, to: c.sourceOfTruth });
    }

    await db
      .insert(integrationSyncMappings)
      .values({
        integrationId,
        field: c.field,
        sourceOfTruth: c.sourceOfTruth,
        strategy: c.strategy,
        updatedBy: userId,
      })
      .onConflictDoUpdate({
        target: [integrationSyncMappings.integrationId, integrationSyncMappings.field],
        set: {
          sourceOfTruth: c.sourceOfTruth,
          strategy: c.strategy,
          updatedBy: userId,
          updatedAt: new Date(),
        },
      });
  }

  return { changed: diffs, projectId: row.projectId, orgId: row.orgId };
}

/**
 * Run one sync round / 拉一轮同步。
 *
 * ★ The return value describes what happened, not merely success or failure: how
 *   many fields were accepted, how many written back, how many conflicts opened,
 *   how many echoes were blocked. A sync endpoint that answers only "200" tells you
 *   nothing on the day it goes wrong.
 *
 *   返回的是「发生了什么」而不是「成功/失败」：接受了几个字段、回写了几个、
 *   生成了几个冲突、挡住了几次循环。一个只回 200 的同步接口，出问题时什么都
 *   查不出来。
 */
export async function runSync(
  db: Database,
  registry: IntegrationRegistry,
  integrationId: string,
) {
  const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
  if (!row) throw notFound('integration');

  const provider = row.provider as IntegrationProvider;
  if (!registry.has(provider)) {
    throw fail(
      'UNSUPPORTED_FEATURE',
      'integration.transport_not_implemented',
      `${PROVIDER_LABELS[provider]} 的传输层还没有实现`,
      { params: { provider }, details: { provider, } },
    );
  }
  const adapter = registry.get(provider);
  const conn = { config: row.config, credentialRef: row.credentialRef };

  const mappingRows = await db
    .select()
    .from(integrationSyncMappings)
    .where(eq(integrationSyncMappings.integrationId, integrationId));
  const mappings: SyncMapping[] = mappingRows.map((m) => ({
    field: m.field as SyncField,
    sourceOfTruth: m.sourceOfTruth as SyncMapping['sourceOfTruth'],
    strategy: m.strategy as SyncMapping['strategy'],
  }));

  const links = await db
    .select()
    .from(integrationObjectLinks)
    .where(eq(integrationObjectLinks.integrationId, integrationId));

  const autoRules = await db
    .select()
    .from(syncConflictRules)
    .where(eq(syncConflictRules.integrationId, integrationId));
  const autoBy = new Map(autoRules.map((a) => [similarityKey(integrationId, a.field as SyncField), a]));

  const itemIds = links.map((l) => l.workItemId);
  const items =
    itemIds.length > 0
      ? await db.select().from(workItems).where(inArray(workItems.id, itemIds))
      : [];
  const itemById = new Map(items.map((i) => [i.id, i]));

  const ownTag = originTagFor(row.projectId);
  const summary = {
    accepted: 0,
    writtenBack: 0,
    conflicts: 0,
    autoResolved: 0,
    echoesBlocked: 0,
    warned: 0,
    externalDeleted: 0,
  };
  const notes: string[] = [];

  for (const link of links) {
    const item = itemById.get(link.workItemId);
    if (!item) continue;

    let external;
    try {
      external = await adapter.fetchObject(conn, link.externalKey);
    } catch (e) {
      /**
       * ★ When the external system is unreachable, mark the integration and pause
       *   syncing; catch up once it recovers (§11). Pushing on only turns one bad
       *   round into a pile of fake conflicts.
       *
       *   外部不可用时标记异常并暂停同步，恢复后补同步（§11）。继续跑下去只会把
       *   一整轮的失败写成一堆假冲突。
       */
      await db
        .update(integrations)
        .set({
          status: 'paused',
          statusReason: e instanceof Error ? e.message : '外部服务不可用',
          updatedAt: new Date(),
        })
        .where(eq(integrations.id, integrationId));
      throw fail(
        'EXTERNAL_ERROR',
        'integration.sync_paused',
        `同步已暂停：${e instanceof Error ? e.message : '外部服务不可用'}`,
        { params: { detail: e instanceof Error ? e.message : 'unavailable' }, details: { integrationId, } },
      );
    }

    if (!external) continue;

    const plan = planSync(external, {
      mappings,
      aposSide: aposSnapshot(item),
      lastSyncedValues: link.lastSyncedValues,
      lastSyncedAt: link.lastSyncedAt?.getTime() ?? null,
      ownOriginTag: ownTag,
    } satisfies SyncContext);

    summary.echoesBlocked += plan.echoes;

    if (plan.externalDeleted) {
      summary.externalDeleted += 1;
      await db
        .update(integrationObjectLinks)
        .set({ externalDeletedAt: new Date() })
        .where(eq(integrationObjectLinks.id, link.id));
      notes.push(`${link.externalKey} 在外部系统已被删除，本地数据保留并已标注`);
      continue;
    }

    for (const action of plan.actions) {
      const r = action.resolution;

      if (r.kind === 'writeback') {
        await adapter.writeField(conn, link.externalKey, action.field, r.value, ownTag);
        summary.writtenBack += 1;
        continue;
      }

      if (r.kind === 'accept' || r.kind === 'merge') {
        summary.accepted += 1;
        continue;
      }

      if (r.kind === 'accept_and_warn') {
        summary.warned += 1;
        notes.push(r.note);
        continue;
      }

      if (r.kind === 'conflict') {
        /**
         * ★ If the user ticked "handle conflicts like this automatically from now on",
         *   stop bothering them. What gets remembered is "who wins on this field",
         *   not "who wins on this object" — the former is plainly what they meant
         *   when they ticked the box.
         *
         *   用户勾过「以后同类冲突自动按此处理」就不再打扰他；记的是「这个字段以后
         *   听谁的」，不是「这条对象以后听谁的」。
         */
        const rule = autoBy.get(similarityKey(integrationId, action.field));
        if (rule) {
          summary.autoResolved += 1;
          if (rule.winner === 'apos') {
            await adapter.writeField(conn, link.externalKey, action.field, r.apos.value, ownTag);
          }
          await db.insert(syncConflicts).values({
            orgId: row.orgId,
            projectId: row.projectId,
            integrationId,
            linkId: link.id,
            field: action.field,
            aposSide: r.apos as unknown as Record<string, unknown>,
            externalSide: r.external as unknown as Record<string, unknown>,
            sourceOfTruth: r.sourceOfTruth,
            status: 'auto_resolved',
            resolvedWinner: rule.winner,
            resolvedAt: new Date(),
            autoResolved: true,
          });
          continue;
        }

        /**
         * ★ Keep at most one pending conflict per field.
         *
         *   While a conflict is unresolved the baseline does not advance (which is
         *   correct), so every sync round re-derives the very same conflict. Without
         *   de-duplication an integration polling every 5 minutes piles up close to
         *   three hundred identical rows in a day, and after the user resolves the
         *   first one there are still two hundred and ninety-nine left — the feature
         *   passes its tests and is unusable in production.
         *
         *   The existing row still has its snapshot refreshed: the external side may
         *   have changed again, and what the user is shown must be the current value,
         *   not the value from the first time the conflict appeared.
         *
         *   同一个字段的未处理冲突只留一条；已有的那条要更新快照，给用户看的必须是
         *   现在的值，不是第一次冲突时的值。
         */
        const [existing] = await db
          .select()
          .from(syncConflicts)
          .where(
            and(
              eq(syncConflicts.linkId, link.id),
              eq(syncConflicts.field, action.field),
              eq(syncConflicts.status, 'pending'),
            ),
          );

        if (existing) {
          await db
            .update(syncConflicts)
            .set({
              aposSide: r.apos as unknown as Record<string, unknown>,
              externalSide: r.external as unknown as Record<string, unknown>,
              sourceOfTruth: r.sourceOfTruth,
            })
            .where(eq(syncConflicts.id, existing.id));
          continue;
        }

        summary.conflicts += 1;
        await db.insert(syncConflicts).values({
          orgId: row.orgId,
          projectId: row.projectId,
          integrationId,
          linkId: link.id,
          field: action.field,
          aposSide: r.apos as unknown as Record<string, unknown>,
          externalSide: r.external as unknown as Record<string, unknown>,
          sourceOfTruth: r.sourceOfTruth,
          status: 'pending',
        });
      }
    }

    await db
      .update(integrationObjectLinks)
      .set({
        lastSyncedValues: nextSyncedValues(plan, link.lastSyncedValues),
        lastSyncedAt: new Date(),
      })
      .where(eq(integrationObjectLinks.id, link.id));
  }

  const prevStats = (row.stats ?? {}) as Record<string, number>;
  await db
    .update(integrations)
    .set({
      lastSyncAt: new Date(),
      status: 'active',
      statusReason: null,
      stats: {
        ...prevStats,
        syncRuns: (prevStats['syncRuns'] ?? 0) + 1,
        /** "Blocked N echo syncs" has to accumulate; one round's number proves nothing */
        echoesBlocked: (prevStats['echoesBlocked'] ?? 0) + summary.echoesBlocked,
      },
      updatedAt: new Date(),
    })
    .where(eq(integrations.id, integrationId));

  return { ...summary, notes, objects: links.length };
}

/**
 * The APOS-side field snapshot. Status is driven by the Flow Engine, so the author
 * is recorded as the system.
 */
function aposSnapshot(item: typeof workItems.$inferSelect): Partial<Record<SyncField, SideSnapshot>> {
  const at = item.updatedAt.toISOString();
  return {
    status: { value: item.status, changedAt: at, changedBy: '系统', actorType: 'system' },
    requirement_content: {
      value: item.description ?? '',
      changedAt: at,
      changedBy: '系统',
      actorType: 'system',
    },
    assignee: {
      value: item.ownerId ?? null,
      changedAt: at,
      changedBy: '系统',
      actorType: 'system',
    },
    due_date: {
      value: item.plannedEnd?.toISOString() ?? null,
      changedAt: at,
      changedBy: '系统',
      actorType: 'system',
    },
  };
}

export async function listConflicts(db: Database, projectId: string) {
  const rows = await db
    .select()
    .from(syncConflicts)
    .where(and(eq(syncConflicts.projectId, projectId), eq(syncConflicts.status, 'pending')))
    .orderBy(desc(syncConflicts.createdAt));

  if (rows.length === 0) return { conflicts: [], hotspots: [] };

  const linkIds = [...new Set(rows.map((r) => r.linkId))];
  const links = await db
    .select()
    .from(integrationObjectLinks)
    .where(inArray(integrationObjectLinks.id, linkIds));
  const linkById = new Map(links.map((l) => [l.id, l]));

  const itemIds = [...new Set(links.map((l) => l.workItemId))];
  const items =
    itemIds.length > 0
      ? await db.select().from(workItems).where(inArray(workItems.id, itemIds))
      : [];
  const itemById = new Map(items.map((i) => [i.id, i]));

  const conflicts = rows.map((r) => {
    const link = linkById.get(r.linkId);
    const item = link ? itemById.get(link.workItemId) : undefined;
    const field = r.field as SyncField;

    return {
      id: r.id,
      integrationId: r.integrationId,
      field,
      fieldLabel: SYNC_FIELD_LABELS[field] ?? field,
      externalKey: link?.externalKey ?? '—',
      externalUrl: link?.externalUrl ?? null,
      workItemId: link?.workItemId ?? null,
      workItemTitle: item?.title ?? null,
      apos: r.aposSide as unknown as SideSnapshot,
      external: r.externalSide as unknown as SideSnapshot,
      sourceOfTruth: r.sourceOfTruth,
      /** The line shown in the UI: "the Source of Truth for the status field is APOS" */
      sotNote: `「${SYNC_FIELD_LABELS[field] ?? field}」的 Source of Truth 是${r.sourceOfTruth === 'apos' ? ' APOS' : '外部系统'}`,
      createdAt: r.createdAt.toISOString(),
    };
  });

  return {
    conflicts,
    hotspots: conflictHotspots(rows.map((r) => ({ field: r.field as SyncField }))).map((h) => ({
      ...h,
      fieldLabel: SYNC_FIELD_LABELS[h.field] ?? h.field,
    })),
  };
}

export async function resolveConflict(
  db: Database,
  registry: IntegrationRegistry,
  input: {
    conflictId: string;
    winner: 'apos' | 'external';
    applyToSimilar: boolean;
    userId: string;
  },
) {
  const [conflict] = await db
    .select()
    .from(syncConflicts)
    .where(eq(syncConflicts.id, input.conflictId));
  if (!conflict) throw notFound('conflict');
  if (conflict.status !== 'pending') {
    throw fail(
      'VERSION_CONFLICT',
      'integration.conflict_already_handled',
      '该冲突已被处理',
      { details: { status: conflict.status } },
    );
  }

  const [row] = await db
    .select()
    .from(integrations)
    .where(eq(integrations.id, conflict.integrationId));
  if (!row) throw notFound('integration');

  const [link] = await db
    .select()
    .from(integrationObjectLinks)
    .where(eq(integrationObjectLinks.id, conflict.linkId));
  if (!link) throw notFound('external_object_link');

  const field = conflict.field as SyncField;
  const apos = conflict.aposSide as unknown as SideSnapshot;
  const external = conflict.externalSide as unknown as SideSnapshot;
  const provider = row.provider as IntegrationProvider;

  // Picking APOS writes the APOS value back to the external system; picking external
  // leaves it to the caller to land the value on the Work Item
  if (input.winner === 'apos' && registry.has(provider)) {
    await registry
      .get(provider)
      .writeField(
        { config: row.config, credentialRef: row.credentialRef },
        link.externalKey,
        field,
        apos.value,
        originTagFor(row.projectId),
      );
  }

  await db
    .update(syncConflicts)
    .set({
      status: 'resolved',
      resolvedWinner: input.winner,
      resolvedBy: input.userId,
      resolvedAt: new Date(),
    })
    .where(eq(syncConflicts.id, input.conflictId));

  // Once resolved, advance the baseline to the winner's value — otherwise the exact
  // same conflict comes back on the next round
  await db
    .update(integrationObjectLinks)
    .set({
      lastSyncedValues: {
        ...link.lastSyncedValues,
        [field]: input.winner === 'apos' ? apos.value : external.value,
      },
    })
    .where(eq(integrationObjectLinks.id, link.id));

  if (input.applyToSimilar) {
    await db
      .insert(syncConflictRules)
      .values({
        integrationId: conflict.integrationId,
        field,
        winner: input.winner,
        createdBy: input.userId,
      })
      .onConflictDoUpdate({
        target: [syncConflictRules.integrationId, syncConflictRules.field],
        set: { winner: input.winner, createdBy: input.userId, createdAt: new Date() },
      });
  }

  return {
    ok: true as const,
    projectId: row.projectId,
    orgId: row.orgId,
    field,
    winner: input.winner,
    appliedValue: input.winner === 'apos' ? apos.value : external.value,
    workItemId: link.workItemId,
  };
}

/**
 * Disconnect an integration / 断开连接。
 *
 * ★ Spell out the consequences before anyone clicks (page doc 14 §7): "after
 *   disconnecting, 3 Agents can no longer run code tasks and 5 work items stop
 *   syncing status". A confirmation dialog that only asks "are you sure?" has
 *   asked nothing at all.
 *
 *   必须先说清影响再让人点 —— 一个只问「确定吗」的确认框，等于没问。
 */
export async function disconnectImpact(db: Database, integrationId: string) {
  const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
  if (!row) throw notFound('integration');

  const links = await db
    .select()
    .from(integrationObjectLinks)
    .where(eq(integrationObjectLinks.integrationId, integrationId));

  const pending = await db
    .select()
    .from(syncConflicts)
    .where(
      and(eq(syncConflicts.integrationId, integrationId), eq(syncConflicts.status, 'pending')),
    );

  const provider = row.provider as IntegrationProvider;
  const effects: string[] = [];

  if (links.length > 0) {
    effects.push(`${links.length} 个任务与外部对象的关联会断开，状态不再同步`);
  }
  if (pending.length > 0) {
    effects.push(`${pending.length} 个未处理的同步冲突会一并消失`);
  }
  if (row.category === 'communication') {
    effects.push('决策提醒与升级通知不再发到这个群组');
  }
  if (row.category === 'code') {
    effects.push('Agent 无法再创建分支与 PR，CI 结果不再回流到验收');
  }
  if (effects.length === 0) {
    effects.push('当前没有关联对象，断开不影响正在进行的工作');
  }

  return {
    provider,
    providerLabel: PROVIDER_LABELS[provider] ?? provider,
    displayName: row.displayName,
    effects,
    linkedItems: links.length,
    pendingConflicts: pending.length,
  };
}

export async function disconnectIntegration(db: Database, integrationId: string) {
  const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
  if (!row) throw notFound('integration');

  await db.delete(integrations).where(eq(integrations.id, integrationId));
  return { ok: true as const, projectId: row.projectId, orgId: row.orgId, provider: row.provider };
}

export async function updateNotificationConfig(
  db: Database,
  integrationId: string,
  config: NotificationConfig,
) {
  const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
  if (!row) throw notFound('integration');
  if (row.category !== 'communication') {
    throw fail(
      'VALIDATION_FAILED',
      'integration.notify_needs_collab_kind',
      '只有协同类集成才有通知配置',
      { details: { category: row.category, } },
    );
  }

  await db
    .update(integrations)
    .set({
      notificationConfig: config as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .where(eq(integrations.id, integrationId));

  /**
   * Report which notification types were turned off (page doc 14 §10, the
   * `notification_disabled` analytics event). A high opt-out rate means that kind of
   * notification is not worth sending — that is something the product needs to know,
   * not the user's fault.
   *
   * 被关掉的通知类型要报出来 —— 关闭率高说明这类通知没价值，那是产品该知道的事，
   * 不是用户的错。
   */
  const disabled = NOTIFY_EVENTS.filter((e) => !config.events.includes(e.key)).map((e) => e.key);
  return { ok: true as const, projectId: row.projectId, orgId: row.orgId, disabled };
}

/** Link a Work Item to an external object / 建立 Work Item ↔ 外部对象的映射 */
export async function linkObject(
  db: Database,
  input: { integrationId: string; workItemId: string; externalKey: string; externalUrl?: string },
) {
  const [row] = await db
    .select()
    .from(integrations)
    .where(eq(integrations.id, input.integrationId));
  if (!row) throw notFound('integration');

  const [item] = await db.select().from(workItems).where(eq(workItems.id, input.workItemId));
  if (!item) throw notFound('work_item');

  const [dup] = await db
    .select()
    .from(integrationObjectLinks)
    .where(
      and(
        eq(integrationObjectLinks.integrationId, input.integrationId),
        eq(integrationObjectLinks.workItemId, input.workItemId),
      ),
    );
  if (dup) {
    /**
     * ★ §11: "one Work Item mapped to several external objects — not allowed,
     *   validated at configuration time". Two mappings mean write-back has two
     *   targets and pulls have two sources, at which point the Source-of-Truth
     *   decision stops meaning anything.
     *
     *   同一 Work Item 不允许映射到多个外部对象，配置时就要校验住。
     */
    throw fail(
      'VALIDATION_FAILED',
      'integration.work_item_already_linked',
      `该任务已映射到 ${dup.externalKey}。一个任务只能映射一个外部对象，否则同步没有确定的方向`,
      { params: { externalKey: dup.externalKey }, details: { existing: dup.externalKey } },
    );
  }

  const [link] = await db
    .insert(integrationObjectLinks)
    .values({
      integrationId: input.integrationId,
      workItemId: input.workItemId,
      externalKey: input.externalKey,
      externalUrl: input.externalUrl ?? null,
    })
    .returning();

  return { id: link!.id, projectId: row.projectId, orgId: row.orgId };
}

/**
 * Credential reference / 凭证引用。
 *
 * ★ The current implementation turns the plaintext into an irreversible reference
 *   key and drops the plaintext. Real secret management (KMS / Vault) is not wired
 *   up yet, but the shape of the interface is already right: the business database
 *   only ever holds a reference, so swapping in the real implementation touches no
 *   caller. Projects that store the token straight into `integrations.credential`
 *   and say "we'll fix it later" never do.
 *
 *   业务库里永远只有引用，换成真实实现时不需要改调用方。
 */
function refOf(credential: string | null): string | null {
  if (!credential) return null;
  return `secret://local/${hash(credential)}`;
}

function hintOf(credential: string | null): string | null {
  if (!credential) return null;
  return `****${credential.slice(-4)}`;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/**
 * Ingest CI results from the code repository — the data source behind the Quality tab
 * in page doc 12 / 从代码仓库回流 CI 结果。
 *
 * ★ The `work_items.typeData.qualityGate` field has always existed and the Policy
 *   engine has always read it (the "no release while tests are failing" rule rests
 *   on it) — but **nothing ever wrote it**. So that Policy could never fire and the
 *   Quality tab could never compute anything: not a hard algorithm, just no data
 *   source. This function is that data source.
 *
 * ★ If it cannot be fetched, write nothing. Defaulting to `testsPassed: true` would
 *   turn "no release while tests are failing" into a rule that always lets things
 *   through — considerably more dangerous than not having the rule at all.
 *
 *   抓不到就不写：默认值会让那条规则变成永远放行的规则，比没有这条规则更危险。
 */
export async function ingestCiResults(
  db: Database,
  registry: IntegrationRegistry,
  integrationId: string,
) {
  const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
  if (!row) throw notFound('integration');
  if (row.category !== 'code') {
    throw fail(
      'VALIDATION_FAILED',
      'integration.ci_needs_code_kind',
      '只有代码类集成能回流 CI 结果',
      { details: { category: row.category, } },
    );
  }

  const provider = row.provider as IntegrationProvider;
  if (!registry.has(provider)) {
    throw fail(
      'UNSUPPORTED_FEATURE',
      'integration.transport_not_implemented',
      `${PROVIDER_LABELS[provider]} 的传输层还没有实现`,
      { params: { provider }, details: { provider, } },
    );
  }

  const adapter = registry.get(provider);
  if (!hasCiSupport(adapter)) {
    /**
     * ★ "This provider does not expose CI results" and "CI did not run" are two
     *   different things. Conflate them and the user keeps believing their own CI
     *   is misconfigured.
     *
     *   两者混在一起的话，用户会一直以为是自己 CI 没配好。
     */
    return { updated: 0, skipped: 0, unsupported: true as const, notes: [
      `${PROVIDER_LABELS[provider]} 的适配器不提供 CI 结果，质量 Tab 的测试类指标会显示未接入`,
    ] };
  }

  const links = await db
    .select()
    .from(integrationObjectLinks)
    .where(eq(integrationObjectLinks.integrationId, integrationId));

  const conn = { config: row.config, credentialRef: row.credentialRef };
  let updated = 0;
  let skipped = 0;
  const notes: string[] = [];

  for (const link of links) {
    if (link.externalDeletedAt) continue;

    let ci;
    try {
      ci = await adapter.fetchCiResult(conn, link.externalKey);
    } catch (e) {
      skipped += 1;
      notes.push(`${link.externalKey}: ${e instanceof Error ? e.message : '拉取失败'}`);
      continue;
    }

    // No CI, or CI has not finished — write nothing in either case. Better that the
    // metric reads "not connected" than that it reads a number we invented
    if (!ci || ci.passed === null) {
      skipped += 1;
      continue;
    }

    /**
     * ★ Merge inside a single UPDATE rather than reading the column out and writing
     *   the whole thing back. The other writer is the workspace verification an Agent
     *   runs as it finishes (agent/ingest.ts), and the two sides write *different*
     *   fields inside `qualityGate`: a whole-column overwrite wipes out the other
     *   half, and what gets lost is the evidence the qualityGatePassed gate judges on.
     *
     *   一条 UPDATE 里合并，不再读出来再整列写回 —— 整列覆盖会抹掉另一个写入者
     *   写进 qualityGate 的那几个字段。
     */
    const merged = await db
      .update(workItems)
      .set({
        typeData: mergeTypeDataNested('qualityGate', {
          testsPassed: ci.passed,
          ...(ci.coverage === null ? {} : { coverage: ci.coverage }),
          ciSha: ci.sha,
          ciFailedChecks: ci.failedChecks,
          ciCheckedAt: new Date().toISOString(),
        }),
        updatedAt: new Date(),
      })
      .where(eq(workItems.id, link.workItemId))
      .returning({ id: workItems.id });
    if (merged.length === 0) continue;
    updated += 1;
  }

  return { updated, skipped, unsupported: false as const, notes };
}

interface CiCapable {
  fetchCiResult(
    conn: { config: Record<string, unknown>; credentialRef: string | null },
    externalKey: string,
  ): Promise<{
    sha: string;
    passed: boolean | null;
    coverage: number | null;
    failedChecks: string[];
  } | null>;
}

function hasCiSupport(adapter: unknown): adapter is CiCapable {
  return typeof (adapter as CiCapable).fetchCiResult === 'function';
}
