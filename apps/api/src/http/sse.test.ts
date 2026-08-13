import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { channelsFor, EventBus } from '../modules/event/bus';
import { resetDb, seedFixture, testDb, type Fixture } from '../test/db';
import { waitFor } from '../test/agent-fixtures';

const db = testDb();
let fx: Fixture;

beforeEach(async () => {
  await resetDb(db);
  fx = await seedFixture(db);
});

afterAll(async () => {
  await resetDb(db);
});

function event(overrides: Partial<Parameters<typeof channelsFor>[0]> = {}) {
  return {
    id: 1n,
    type: 'work_item.status_changed' as const,
    level: 'milestone' as const,
    orgId: fx.orgId,
    projectId: fx.projectId,
    actor: { type: 'system' as const, id: null },
    subjectType: 'work_item' as const,
    subjectId: 'wi-1',
    payload: {},
    contextSnapshot: null,
    causationId: null,
    correlationId: randomUUID(),
    occurredAt: new Date(),
    ...overrides,
  };
}

describe('频道映射', () => {
  it('Work Item 事件同时进项目频道与任务频道', () => {
    const channels = channelsFor(event());
    expect(channels).toContain(`project:${fx.projectId}:board`);
    expect(channels).toContain('work_item:wi-1');
  });

  it('Run 事件同时进 Run 频道与所属任务频道', () => {
    const channels = channelsFor(
      event({
        type: 'agent_run.completed',
        subjectType: 'agent_run',
        subjectId: 'run-1',
        payload: { workItemId: 'wi-9' },
      }),
    );
    expect(channels).toContain('run:run-1');
    expect(channels).toContain('work_item:wi-9');
  });

  it('决策事件进责任人的个人频道 —— 全局角标靠它', () => {
    const channels = channelsFor(
      event({
        type: 'decision.created',
        subjectType: 'decision',
        subjectId: 'dec-1',
        payload: { assigneeId: 'user-7' },
      }),
    );
    expect(channels).toContain('user:user-7:decisions');
  });

  it('Agent 发起的事件进该 Agent 的频道', () => {
    const channels = channelsFor(
      event({ actor: { type: 'agent', id: 'agent-3' } }),
    );
    expect(channels).toContain('agent:agent-3');
  });

  it('频道去重，不会重复推送', () => {
    const channels = channelsFor(
      event({
        subjectType: 'agent_run',
        subjectId: 'run-1',
        payload: { workItemId: 'run-1' },
      }),
    );
    expect(new Set(channels).size).toBe(channels.length);
  });
});

describe('EventBus', () => {
  it('只推给订阅了命中频道的订阅者', () => {
    const bus = new EventBus();
    const received: string[] = [];
    const other: string[] = [];

    bus.subscribe([`project:${fx.projectId}:board`], (e) => received.push(e.type));
    bus.subscribe(['project:other:board'], (e) => other.push(e.type));

    bus.publish([event()]);

    expect(received).toEqual(['work_item.status_changed']);
    expect(other).toEqual([]);
  });

  it('★ 同一订阅者订了多个命中频道时只收到一次', () => {
    const bus = new EventBus();
    const received: string[] = [];

    // 同时订阅项目频道与任务频道，两者都会命中同一事件
    bus.subscribe([`project:${fx.projectId}:board`, 'work_item:wi-1'], (e) =>
      received.push(e.id),
    );

    bus.publish([event()]);
    expect(received).toHaveLength(1);
  });

  it('取消订阅后不再收到', () => {
    const bus = new EventBus();
    const received: string[] = [];
    const unsub = bus.subscribe(['work_item:wi-1'], (e) => received.push(e.id));

    bus.publish([event()]);
    unsub();
    bus.publish([event({ id: 2n })]);

    expect(received).toHaveLength(1);
  });

  it('★ 单个订阅者抛异常不影响其他订阅者', () => {
    const bus = new EventBus();
    const survived: string[] = [];

    bus.subscribe(['work_item:wi-1'], () => {
      throw new Error('订阅者炸了');
    });
    bus.subscribe(['work_item:wi-1'], (e) => survived.push(e.id));

    expect(() => bus.publish([event()])).not.toThrow();
    expect(survived).toHaveLength(1);
  });

  it('取消订阅会清理空频道，不泄漏内存', () => {
    const bus = new EventBus();
    const unsub = bus.subscribe(['work_item:wi-1'], () => {});
    expect(bus.subscriberCount()).toBe(1);
    unsub();
    expect(bus.subscriberCount()).toBe(0);
  });
});

describe('★ 事务提交后才发布', () => {
  it('流转成功时发布事件；被拒绝时一条都不发', async () => {
    const { createWorkItem } = await import('../test/db');
    const { transition } = await import('../modules/flow/transition');
    const { defaultBus } = await import('../modules/event/bus');

    const item = await createWorkItem(db, fx, {
      executorType: 'agent',
      executorId: randomUUID(),
    });

    const received: string[] = [];
    const unsub = defaultBus.subscribe([`work_item:${item.id}`], (e) => received.push(e.type));

    try {
      // 非法流转：不应发布任何事件
      await transition(db, {
        workItemId: item.id,
        trigger: 'release_completed',
        actor: { type: 'system', id: null },
        correlationId: randomUUID(),
      });
      expect(received).toHaveLength(0);

      // 合法流转：发布
      await transition(db, {
        workItemId: item.id,
        trigger: 'run_dispatched',
        actor: { type: 'system', id: null },
        correlationId: randomUUID(),
      });

      await waitFor(async () => (received.length > 0 ? received : null), {
        label: '未收到流转事件',
      });
      expect(received).toContain('work_item.status_changed');
      expect(received).toContain('policy.evaluated');
    } finally {
      unsub();
    }
  });

  it('★ 事务回滚时不发布已写入 outbox 的事件', async () => {
    const { createWorkItem } = await import('../test/db');
    const { transition } = await import('../modules/flow/transition');
    const { defaultBus } = await import('../modules/event/bus');

    const item = await createWorkItem(db, fx, {
      status: 'reviewing',
      acceptanceCriteria: [
        {
          id: 'a',
          text: '未完成项',
          verification: 'auto',
          status: 'pending',
          evidenceRef: null,
          verifiedAt: null,
        },
      ],
    });

    const received: string[] = [];
    const unsub = defaultBus.subscribe([`work_item:${item.id}`], (e) => received.push(e.type));

    try {
      // 强制放行但不填原因 → emit 抛异常 → 整个事务回滚
      await expect(
        transition(db, {
          workItemId: item.id,
          trigger: 'review_passed',
          actor: { type: 'human', id: fx.userId },
          overrideGuards: ['acceptanceCriteriaMet', 'qualityGatePassed'],
          correlationId: randomUUID(),
        }),
      ).rejects.toThrow();

      // policy.evaluated 已经进了 outbox，但事务回滚了，绝不能推给浏览器
      expect(received).toHaveLength(0);
    } finally {
      unsub();
    }
  });
});

/**
 * ★★ 频道鉴权 —— 这条流最容易被忽略的一半。
 *
 *   REST 那边有成员关系闸门按 URL 形状统一拦截，而 SSE 的作用域写在
 *   query 的频道名里，闸门看不见。此前这里只验令牌不验频道，于是
 *   任何登录账号都能订阅别的组织的项目，拿到它的全部实时事件 ——
 *   同一个人打 REST 会拿到 404。
 *
 *   这一组测的就是「REST 拦得住的，SSE 也拦得住」。
 */
describe('★ SSE 频道鉴权', () => {
  const authorize = async (userId: string, channels: string[]) => {
    const { authorizeChannels } = await import('./sse-channels');
    const { createRbac } = await import('./rbac');
    const rbac = createRbac({
      db,
      projectOfResource: async (kind, id) => {
        if (kind !== 'work-items') return null;
        const { workItems } = await import('@apos/db');
        const { eq } = await import('drizzle-orm');
        const [row] = await db
          .select({ projectId: workItems.projectId })
          .from(workItems)
          .where(eq(workItems.id, id));
        return row?.projectId ?? null;
      },
      requireUserId: () => userId,
    });
    const req = { headers: {} } as never;
    const actor = await rbac.resolveActor(req, userId, null);
    return authorizeChannels(
      { db, projectAccess: rbac.projectAccess, projectOfResource: async () => null },
      req,
      actor,
      channels,
    );
  };

  it('成员可以订阅本项目的看板频道', async () => {
    const { allowed, denied } = await authorize(fx.userId, [`project:${fx.projectId}:board`]);
    expect(allowed).toEqual([`project:${fx.projectId}:board`]);
    expect(denied).toEqual([]);
  });

  it('★ 外组织用户订阅本项目的频道被剔除', async () => {
    const { createOutsider } = await import('../test/db');
    const outsider = await createOutsider(db, fx);

    const { allowed, denied } = await authorize(outsider.userId, [
      `project:${fx.projectId}:board`,
    ]);
    expect(allowed).toEqual([]);
    expect(denied).toEqual([`project:${fx.projectId}:board`]);
  });

  it('★ 同组织但不是项目成员的人也订不到', async () => {
    const { createMember } = await import('../test/db');
    const stranger = await createMember(db, fx, { projectRole: null });

    const { allowed } = await authorize(stranger, [`project:${fx.projectId}:board`]);
    expect(allowed).toEqual([]);
  });

  it('★ 只剔除越权的那些，其余频道照常订上', async () => {
    const { createOutsider } = await import('../test/db');
    const outsider = await createOutsider(db, fx);

    const mine = `user:${outsider.userId}:decisions`;
    const theirs = `project:${fx.projectId}:board`;
    const { allowed, denied } = await authorize(outsider.userId, [mine, theirs]);

    expect(allowed).toEqual([mine]);
    expect(denied).toEqual([theirs]);
  });

  it('★ 别人的决策频道订不到 —— 作用域就是「派给我的」', async () => {
    const { createMember } = await import('../test/db');
    const other = await createMember(db, fx, { projectRole: 'pm' });

    const { allowed } = await authorize(fx.userId, [`user:${other}:decisions`]);
    expect(allowed).toEqual([]);
  });

  it('★ 认不出来的频道一律拒，不是默认放行', async () => {
    const { allowed, denied } = await authorize(fx.userId, [
      'project:not-a-uuid',
      'whatever:1',
      `project:${fx.projectId}:board:extra`,
      '',
    ]);
    expect(allowed).toEqual([]);
    expect(denied).toHaveLength(4);
  });

  it('★ 查不到所属项目的资源频道被拒，不能拿来探 id 存不存在', async () => {
    const { allowed } = await authorize(fx.userId, [`work_item:${randomUUID()}`]);
    expect(allowed).toEqual([]);
  });
});
