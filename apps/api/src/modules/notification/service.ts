import { and, eq } from 'drizzle-orm';
import {
  decisions,
  integrations,
  notificationDeliveries,
  projects,
  users,
  workItems,
  type Database,
} from '@apos/db';
import {
  DEFAULT_NOTIFICATION_CONFIG,
  type NotificationConfig,
  type NotifyEventKey,
} from '@apos/contracts';
import { buildDecisionMessage, decideNotification, type NotifyMessage } from '@apos/domain';
import type { NotifyTransport } from '@apos/integrations';

/**
 * 通知投递（产品文档十一 / 页面文档 14 §5.5）。
 *
 * ★ 判定在 domain（发不发、找谁、要不要穿透免打扰），
 *   投递在 integrations（怎么发到 Slack / 飞书），
 *   这一层只做「把两边接起来 + 留下记录」。
 *
 * ★ 每一次都落记录，包括**被抑制的**。
 *   通知类功能最典型的故障是静默失败：webhook 被撤销、群被解散、
 *   被免打扰吃掉 —— 而用户只会觉得「这系统从来不提醒我」，
 *   根本不会想到去查投递。查得到，才可能被修。
 */

export interface NotifyDeps {
  db: Database;
  /** provider → 投递实现。没有注册的 provider 会被如实记为「无传输层」*/
  transports: Map<string, NotifyTransport>;
  /** 深链前缀，例如 https://apos.example */
  webBaseUrl: string;
  now?: () => Date;
}

/** 决策产生时通知责任人（产品文档十一的第一类「需要行动」） */
export async function notifyDecisionCreated(
  deps: NotifyDeps,
  decisionId: string,
): Promise<{ delivered: number; suppressed: number; failed: number }> {
  const { db } = deps;
  const [decision] = await db.select().from(decisions).where(eq(decisions.id, decisionId));
  if (!decision) return EMPTY;

  const [project] = await db.select().from(projects).where(eq(projects.id, decision.projectId));
  if (!project) return EMPTY;

  const assignee = decision.assigneeId
    ? (await db.select().from(users).where(eq(users.id, decision.assigneeId)))[0]
    : undefined;

  const item = decision.workItemId
    ? (await db.select().from(workItems).where(eq(workItems.id, decision.workItemId)))[0]
    : undefined;
  void item;

  const now = (deps.now ?? (() => new Date()))();
  const dueAt = decision.dueAt?.getTime() ?? null;

  const message = buildDecisionMessage({
    projectName: project.name,
    title: decision.title,
    assigneeName: assignee?.name ?? null,
    dueInMinutes: dueAt && dueAt > now.getTime() ? Math.round((dueAt - now.getTime()) / 60_000) : null,
    overdueMinutes: dueAt && dueAt <= now.getTime() ? Math.round((now.getTime() - dueAt) / 60_000) : null,
    consequence: decision.consequence,
    recommendation: null,
    /** ★ 深链落到决策中心而不是首页 —— 通知里点进来还要自己找，等于没链接 */
    url: `${deps.webBaseUrl}/projects/${decision.projectId}/decisions`,
    riskLevel: decision.riskLevel,
  });

  return deliver(deps, {
    projectId: decision.projectId,
    orgId: decision.orgId,
    eventKey: 'decision_required',
    subjectType: 'decision',
    subjectId: decision.id,
    riskLevel: decision.riskLevel as 'low' | 'medium' | 'high' | 'critical',
    waitingMinutes: Math.round((now.getTime() - decision.createdAt.getTime()) / 60_000),
    message,
    now,
  });
}

export interface DeliverInput {
  projectId: string;
  orgId: string;
  eventKey: NotifyEventKey;
  subjectType: string;
  subjectId: string | null;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  waitingMinutes?: number;
  message: NotifyMessage;
  now: Date;
}

/**
 * 对项目里所有协同类集成执行一次投递。
 *
 * ★ 判定按**每个集成各自的配置**做：同一个项目可能同时连了
 *   给团队的飞书群和给值班的 Slack 频道，两边的免打扰和开关本来就该不同。
 *   用一份全局配置判定，等于强迫两个受众共用一套打扰策略。
 */
export async function deliver(
  deps: NotifyDeps,
  input: DeliverInput,
): Promise<{ delivered: number; suppressed: number; failed: number }> {
  const { db } = deps;
  const channels = await db
    .select()
    .from(integrations)
    .where(
      and(eq(integrations.projectId, input.projectId), eq(integrations.category, 'communication')),
    );

  let delivered = 0;
  let suppressed = 0;
  let failed = 0;

  const nowMinutes = input.now.getHours() * 60 + input.now.getMinutes();

  for (const channel of channels) {
    const config = (channel.notificationConfig as NotificationConfig | null) ?? DEFAULT_NOTIFICATION_CONFIG;

    const verdict = decideNotification(
      {
        event: input.eventKey,
        riskLevel: input.riskLevel,
        waitingMinutes: input.waitingMinutes,
      },
      config,
      nowMinutes,
    );

    if (!verdict.deliver) {
      suppressed += 1;
      await log(db, input, channel.id, {
        status: 'suppressed',
        suppressedReason: verdict.reason,
      });
      continue;
    }

    // 暂停中的集成不投递 —— 但要记一条，否则用户会以为通知丢了
    if (channel.status !== 'active') {
      failed += 1;
      await log(db, input, channel.id, {
        status: 'failed',
        error: `集成当前状态为 ${channel.status}，未投递`,
      });
      continue;
    }

    const transport = deps.transports.get(channel.provider);
    const webhookUrl = String(channel.config['webhookUrl'] ?? '');

    if (!transport || !webhookUrl) {
      /**
       * ★ 「没有传输层」和「发失败了」要分开记。
       *   前者是这个部署还没接上投递端，后者是接上了但对方拒绝 ——
       *   混成一条的话，用户会一直去重新生成 webhook，
       *   而真正的原因是这个 provider 根本还没实现。
       */
      failed += 1;
      await log(db, input, channel.id, {
        status: 'failed',
        error: !transport
          ? `${channel.provider} 的投递端未实现或未注册，消息没有发出去`
          : '缺少 webhookUrl 配置',
        needsReconfigure: Boolean(transport),
      });
      continue;
    }

    const result = await transport.send({ webhookUrl }, input.message);
    if (result.ok) {
      delivered += 1;
      await log(db, input, channel.id, { status: 'delivered', latencyMs: result.latencyMs });
    } else {
      failed += 1;
      await log(db, input, channel.id, {
        status: 'failed',
        error: result.message,
        needsReconfigure: result.needsReconfigure,
        latencyMs: result.latencyMs,
      });

      /**
       * ★ webhook 被撤销 / 群被解散时把集成标成异常（§11）。
       *   不标的话它会每次都失败一次，而页面上永远显示「● 正常」。
       */
      if (result.needsReconfigure) {
        await db
          .update(integrations)
          .set({ status: 'error', statusReason: result.message, updatedAt: new Date() })
          .where(eq(integrations.id, channel.id));
      }
    }
  }

  return { delivered, suppressed, failed };
}

async function log(
  db: Database,
  input: DeliverInput,
  integrationId: string,
  extra: {
    status: string;
    suppressedReason?: string;
    error?: string;
    needsReconfigure?: boolean;
    latencyMs?: number;
  },
) {
  await db.insert(notificationDeliveries).values({
    orgId: input.orgId,
    projectId: input.projectId,
    integrationId,
    eventKey: input.eventKey,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    title: input.message.title,
    status: extra.status,
    suppressedReason: extra.suppressedReason ?? null,
    error: extra.error ?? null,
    needsReconfigure: extra.needsReconfigure ?? false,
    latencyMs: extra.latencyMs ?? null,
  });
}

const EMPTY = { delivered: 0, suppressed: 0, failed: 0 };

/** 页面上的投递记录 —— 「发过没有」必须查得到 */
export async function listDeliveries(db: Database, projectId: string, limit = 50) {
  const rows = await db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.projectId, projectId))
    .orderBy(notificationDeliveries.createdAt)
    .limit(500);

  const recent = rows.slice(-limit).reverse();

  return {
    deliveries: recent.map((r) => ({
      id: r.id,
      eventKey: r.eventKey,
      title: r.title,
      status: r.status,
      suppressedReason: r.suppressedReason,
      error: r.error,
      needsReconfigure: r.needsReconfigure,
      latencyMs: r.latencyMs,
      createdAt: r.createdAt.toISOString(),
    })),
    stats: {
      delivered: rows.filter((r) => r.status === 'delivered').length,
      suppressed: rows.filter((r) => r.status === 'suppressed').length,
      failed: rows.filter((r) => r.status === 'failed').length,
      /** 需要用户去重新配置的失败 —— 这类不会自己好 */
      needsReconfigure: rows.filter((r) => r.needsReconfigure).length,
    },
  };
}
