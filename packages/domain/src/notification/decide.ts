import type { NotificationConfig, NotifyEventKey } from '@apos/contracts';

/**
 * 通知投递判定（产品文档十一 / 页面文档 14 §5.5）。
 *
 * ★ 「围绕需要行动设计，而不是发送大量 Agent 日志」这句话，
 *   落到代码上就是这个函数：它的职责不是「怎么发」，是**「发不发」**。
 *   一个只管发的通知系统，两天之内就会被用户屏蔽 ——
 *   而屏蔽之后，真正需要行动的通知也一起没了。
 *   所以判定与投递严格分开：判定必须能被单独测到每一条分支。
 *
 * ★ 免打扰保护的是注意力，不是责任。高风险决策必须能穿透 ——
 *   一个「凌晨两点生产库要删数据、等你批」的请求被静音到早上九点，
 *   这个系统就再也不配说「需要你的时候我会来找你」。
 */

export interface NotifyCandidate {
  event: NotifyEventKey;
  /** 高风险决策不受免打扰限制 */
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  /** 决策已经等了多久（分钟），用于升级规则 */
  waitingMinutes?: number;
  /** 决策的责任人；null = 无人认领 */
  assigneeId?: string | null;
}

export type Suppression =
  | 'event_disabled'
  | 'quiet_hours';

export type Decision =
  | { deliver: true; escalateTo: EscalationTarget[]; pauseCriticalPath: boolean }
  | { deliver: false; reason: Suppression; /** 免打扰结束后补发的时刻 */ deferUntil: string | null };

export type EscalationTarget = 'assignee' | 'project_owner' | 'manager';

/**
 * 判定一条通知发不发。
 *
 * @param nowMinutes 当天的分钟数（0–1439），由调用方按项目时区算好 ——
 *   时区换算不该藏在判定逻辑里，否则这个函数就没法脱离时钟测试。
 */
export function decideNotification(
  candidate: NotifyCandidate,
  config: NotificationConfig,
  nowMinutes: number,
): Decision {
  // 1. 用户关掉了这类通知 —— 关掉就是关掉，不存在「重要所以还是发」
  if (!config.events.includes(candidate.event)) {
    return { deliver: false, reason: 'event_disabled', deferUntil: null };
  }

  // 2. 免打扰
  const quiet = config.quietHours;
  if (quiet && inQuietHours(nowMinutes, quiet)) {
    const bypass = config.quietHoursExceptHighRisk && isHighRisk(candidate);
    if (!bypass) {
      return { deliver: false, reason: 'quiet_hours', deferUntil: quiet.to };
    }
  }

  return {
    deliver: true,
    ...escalation(candidate, config),
  };
}

/**
 * 升级规则（产品文档十一）。
 *
 * ★ 命中的是**所有已越过的档位**，不是最高那一档。
 *   只通知最高档的话，等了 24 小时的决策会只找上级、不再提醒责任人 ——
 *   而责任人恰恰是唯一能处理它的人。升级是「叫更多人」，不是「换人叫」。
 */
export function escalation(
  candidate: NotifyCandidate,
  config: NotificationConfig,
): { escalateTo: EscalationTarget[]; pauseCriticalPath: boolean } {
  const waited = candidate.waitingMinutes ?? 0;
  const hit = config.escalation.filter((e) => waited >= e.afterHours * 60);

  if (hit.length === 0) {
    return { escalateTo: ['assignee'], pauseCriticalPath: false };
  }

  const targets = new Set<EscalationTarget>(['assignee']);
  for (const e of hit) targets.add(e.notify);

  return {
    escalateTo: [...targets],
    pauseCriticalPath: hit.some((e) => e.pauseCriticalPath),
  };
}

/** 跨零点的免打扰（22:00–08:00）要按环形区间判断 */
export function inQuietHours(nowMinutes: number, quiet: { from: string; to: string }): boolean {
  const from = toMinutes(quiet.from);
  const to = toMinutes(quiet.to);
  if (from === null || to === null) return false;
  if (from === to) return false;
  return from < to ? nowMinutes >= from && nowMinutes < to : nowMinutes >= from || nowMinutes < to;
}

function isHighRisk(c: NotifyCandidate): boolean {
  return c.riskLevel === 'high' || c.riskLevel === 'critical';
}

export function toMinutes(hhmm: string): number | null {
  const m = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 通知消息体（页面文档 14 §5.5 的模板）。
 *
 * ★ 只放跳转链接，不放「直接批准」按钮（§12.3 的取舍）。
 *   在第三方平台内确认「点按钮的人真的是决策责任人」，
 *   各平台机制都不一样 —— 做不到这一点的直接批准，
 *   会把不可代行的决策变成谁点谁算，那比不做更糟。
 */
export interface NotifyMessage {
  title: string;
  lines: string[];
  /** 深链，点进来落到决策中心 */
  url: string;
  urgent: boolean;
}

export function buildDecisionMessage(input: {
  projectName: string;
  title: string;
  assigneeName: string | null;
  dueInMinutes: number | null;
  overdueMinutes: number | null;
  consequence: string | null;
  recommendation: string | null;
  url: string;
  riskLevel: string;
}): NotifyMessage {
  const lines: string[] = [];

  lines.push(input.title);
  lines.push(
    `责任人：${input.assigneeName ?? '⚠ 无人认领'}　${deadlineText(input.dueInMinutes, input.overdueMinutes)}`,
  );
  // ★ 「不处理会怎样」是把紧迫性从抽象的高优先级变成具体后果的唯一一行
  if (input.consequence) lines.push(input.consequence);
  if (input.recommendation) lines.push(`Agent 建议：${input.recommendation}`);

  return {
    title: `${input.overdueMinutes !== null ? '🔴' : '⚠'} 需要你决策 · ${input.projectName}`,
    lines,
    url: input.url,
    urgent: input.overdueMinutes !== null || input.riskLevel === 'critical',
  };
}

function deadlineText(dueIn: number | null, overdue: number | null): string {
  if (overdue !== null) return `已超时 ${humanMinutes(overdue)}`;
  if (dueIn !== null) return `还有 ${humanMinutes(dueIn)}`;
  return '无时限';
}

function humanMinutes(m: number): string {
  const abs = Math.abs(Math.round(m));
  if (abs < 60) return `${abs} 分钟`;
  const h = Math.floor(abs / 60);
  return h < 24 ? `${h} 小时` : `${Math.floor(h / 24)} 天`;
}
