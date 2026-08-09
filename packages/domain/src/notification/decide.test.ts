import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFICATION_CONFIG, type NotificationConfig } from '@apos/contracts';
import {
  buildDecisionMessage,
  decideNotification,
  escalation,
  inQuietHours,
  toMinutes,
} from './decide';

function config(over: Partial<NotificationConfig> = {}): NotificationConfig {
  return { ...DEFAULT_NOTIFICATION_CONFIG, ...over };
}

const at = (hhmm: string) => toMinutes(hhmm)!;

/**
 * 通知投递判定（产品文档十一）。
 *
 * 这个函数的职责不是「怎么发」，是「发不发」。
 * 一个只管发的通知系统，两天之内就会被用户屏蔽 ——
 * 而屏蔽之后，真正需要行动的通知也一起没了。
 */
describe('用户关掉的类型不发', () => {
  it('默认配置里高频通知是关的', () => {
    const d = decideNotification({ event: 'item_status_changed' }, config(), at('10:00'));
    expect(d).toMatchObject({ deliver: false, reason: 'event_disabled' });
  });

  it('需要决策默认是开的', () => {
    expect(decideNotification({ event: 'decision_required' }, config(), at('10:00')).deliver).toBe(true);
  });

  /** ★ 关掉就是关掉，不存在「这条很重要所以还是发」—— 那是对用户设置的背叛 */
  it('★ 关掉的类型即便是高风险也不发', () => {
    const c = config({ events: ['decision_due_soon'] });
    const d = decideNotification({ event: 'decision_required', riskLevel: 'critical' }, c, at('10:00'));
    expect(d).toMatchObject({ deliver: false, reason: 'event_disabled' });
  });
});

describe('免打扰', () => {
  it('跨零点的免打扰按环形区间判断', () => {
    const q = { from: '22:00', to: '08:00' };
    expect(inQuietHours(at('23:30'), q)).toBe(true);
    expect(inQuietHours(at('02:00'), q)).toBe(true);
    expect(inQuietHours(at('07:59'), q)).toBe(true);
    expect(inQuietHours(at('08:00'), q)).toBe(false);
    expect(inQuietHours(at('14:00'), q)).toBe(false);
  });

  it('不跨零点的免打扰也对', () => {
    const q = { from: '12:00', to: '14:00' };
    expect(inQuietHours(at('13:00'), q)).toBe(true);
    expect(inQuietHours(at('15:00'), q)).toBe(false);
  });

  it('免打扰时段内的普通通知被推迟，并给出补发时刻', () => {
    const d = decideNotification({ event: 'milestone_done', riskLevel: 'low' }, config(), at('02:00'));
    expect(d).toMatchObject({ deliver: false, reason: 'quiet_hours', deferUntil: '08:00' });
  });

  /**
   * ★ 免打扰保护的是注意力，不是责任。
   *   一个「凌晨两点生产库要删数据、等你批」的请求被静音到早上九点，
   *   这个系统就再也不配说「需要你的时候我会来找你」。
   */
  it('★ 高风险决策穿透免打扰', () => {
    const d = decideNotification(
      { event: 'decision_required', riskLevel: 'critical' },
      config(),
      at('02:00'),
    );
    expect(d.deliver).toBe(true);
  });

  it('关掉了「高风险除外」时，高风险也被静音 —— 用户明确要求过', () => {
    const d = decideNotification(
      { event: 'decision_required', riskLevel: 'critical' },
      config({ quietHoursExceptHighRisk: false }),
      at('02:00'),
    );
    expect(d.deliver).toBe(false);
  });

  it('没设免打扰就一直发', () => {
    const d = decideNotification({ event: 'milestone_done' }, config({ quietHours: null }), at('03:00'));
    expect(d.deliver).toBe(true);
  });
});

describe('升级规则', () => {
  it('还没到第一档时只找责任人', () => {
    const e = escalation({ event: 'decision_required', waitingMinutes: 60 }, config());
    expect(e.escalateTo).toEqual(['assignee']);
    expect(e.pauseCriticalPath).toBe(false);
  });

  /**
   * ★ 升级是「叫更多人」，不是「换人叫」。
   *   只通知最高档的话，等了 24 小时的决策会只找上级、不再提醒责任人 ——
   *   而责任人恰恰是唯一能处理它的人。
   */
  it('★ 越过多档时所有档位都通知，责任人始终在列', () => {
    const e = escalation({ event: 'decision_required', waitingMinutes: 25 * 60 }, config());
    expect(e.escalateTo).toContain('assignee');
    expect(e.escalateTo).toContain('project_owner');
    expect(e.escalateTo).toContain('manager');
  });

  it('到 24 小时那一档时暂停关键路径', () => {
    expect(escalation({ event: 'decision_required', waitingMinutes: 9 * 60 }, config()).pauseCriticalPath).toBe(false);
    expect(escalation({ event: 'decision_required', waitingMinutes: 25 * 60 }, config()).pauseCriticalPath).toBe(true);
  });

  it('自定义档位照样生效', () => {
    const c = config({
      escalation: [{ afterHours: 1, notify: 'manager', pauseCriticalPath: true }],
    });
    const e = escalation({ event: 'decision_required', waitingMinutes: 90 }, c);
    expect(e.escalateTo).toEqual(['assignee', 'manager']);
    expect(e.pauseCriticalPath).toBe(true);
  });
});

describe('消息模板', () => {
  it('把「不处理会怎样」和 Agent 建议都带上', () => {
    const m = buildDecisionMessage({
      projectName: '订单系统重构',
      title: '生产数据库索引变更审批',
      assigneeName: '王强',
      dueInMinutes: 120,
      overdueMinutes: null,
      consequence: '不处理将阻塞 5 个下游任务',
      recommendation: '在线创建复合索引',
      url: 'https://apos.example/decisions',
      riskLevel: 'high',
    });

    expect(m.title).toContain('需要你决策');
    expect(m.title).toContain('订单系统重构');
    expect(m.lines.join('\n')).toContain('王强');
    expect(m.lines.join('\n')).toContain('还有 2 小时');
    expect(m.lines.join('\n')).toContain('阻塞 5 个下游任务');
    expect(m.urgent).toBe(false);
  });

  it('超时的标红并置为紧急', () => {
    const m = buildDecisionMessage({
      projectName: 'p',
      title: 't',
      assigneeName: null,
      dueInMinutes: null,
      overdueMinutes: 200,
      consequence: null,
      recommendation: null,
      url: 'u',
      riskLevel: 'low',
    });
    expect(m.title).toContain('🔴');
    expect(m.urgent).toBe(true);
    expect(m.lines.join('\n')).toContain('已超时 3 小时');
  });

  /** 无人认领要在通知里就喊出来 —— 没人管的决策最容易烂在队列里 */
  it('★ 无人认领在消息里直接点名', () => {
    const m = buildDecisionMessage({
      projectName: 'p',
      title: 't',
      assigneeName: null,
      dueInMinutes: 60,
      overdueMinutes: null,
      consequence: null,
      recommendation: null,
      url: 'u',
      riskLevel: 'low',
    });
    expect(m.lines.join('\n')).toContain('无人认领');
  });
});
