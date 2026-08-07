import { beforeEach, describe, expect, it } from 'vitest';
import { defaultMappings } from '@apos/domain';
import { MemoryIntegrationAdapter } from './memory';
import { originTagFor, type ConnectionConfig } from './adapter';
import { nextSyncedValues, planSync, type SyncContext } from './engine';

const PROJECT = 'proj-1';
const TAG = originTagFor(PROJECT);
const CONN: ConnectionConfig = { config: {}, credentialRef: null };

let jira: MemoryIntegrationAdapter;

beforeEach(async () => {
  jira = new MemoryIntegrationAdapter('jira');
  await jira.seed({
    externalKey: 'ORDER-142',
    url: 'https://jira.example/ORDER-142',
    fields: { status: 'executing', assignee: '张伟', due_date: '2026-09-01' },
    lastChange: { originTag: null, by: '李娜', at: '2026-08-05T10:00:00Z' },
  });
});

function ctx(over: Partial<SyncContext> = {}): SyncContext {
  return {
    mappings: defaultMappings(),
    aposSide: {
      status: { value: 'executing', changedAt: '', changedBy: '系统', actorType: 'system' },
      assignee: { value: '张伟', changedAt: '', changedBy: '系统', actorType: 'system' },
      due_date: { value: '2026-09-01', changedAt: '', changedBy: '系统', actorType: 'system' },
    },
    lastSyncedValues: { status: 'executing', assignee: '张伟', due_date: '2026-09-01' },
    lastSyncedAt: Date.parse('2026-08-05T10:00:00Z'),
    ownOriginTag: TAG,
    ...over,
  };
}

/**
 * 同步引擎（页面文档 14 §5.3 / §11）。
 *
 * 这一层负责把「适配器拉回来的外部对象」翻译成「逐字段该做什么」，
 * 真正的判定在 domain 的 resolveSync 里。分开是为了让这里能测到
 * 端到端跑不出来的组合。
 */
describe('拉取后的逐字段判定', () => {
  it('两侧一致时不产生任何动作', async () => {
    const obj = await jira.fetchObject(CONN, 'ORDER-142');
    const plan = planSync(obj!, ctx());
    expect(plan.actions).toHaveLength(0);
  });

  /** 状态的 SoT 是 APOS，默认策略是记录冲突 */
  it('★ 外部手改状态 → 生成冲突，两侧的值与修改人都带出来', async () => {
    await jira.externalEdit('ORDER-142', 'status', 'done', '李娜', '2026-08-05T14:45:00Z');
    const obj = await jira.fetchObject(CONN, 'ORDER-142');

    const plan = planSync(
      obj!,
      ctx({
        aposSide: {
          status: {
            value: 'reviewing',
            changedAt: '2026-08-05T14:32:00Z',
            changedBy: '系统',
            actorType: 'system',
          },
        },
        lastSyncedValues: { status: 'executing' },
      }),
    );

    const status = plan.actions.find((a) => a.field === 'status');
    expect(status?.resolution.kind).toBe('conflict');
    if (status?.resolution.kind !== 'conflict') return;
    expect(status.resolution.external.value).toBe('done');
    expect(status.resolution.external.changedBy).toBe('李娜');
    expect(status.resolution.apos.value).toBe('reviewing');
  });

  /** 负责人的 SoT 是外部 —— 外部改了就直接接受，不惊动任何人 */
  it('外部改负责人直接被接受', async () => {
    await jira.externalEdit('ORDER-142', 'assignee', '王强', '李娜', '2026-08-05T14:45:00Z');
    const obj = await jira.fetchObject(CONN, 'ORDER-142');
    const plan = planSync(obj!, ctx());

    const assignee = plan.actions.find((a) => a.field === 'assignee');
    expect(assignee?.resolution).toEqual({ kind: 'accept', value: '王强' });
  });

  it('外部侧没有这个字段且 APOS 也没有时跳过，不当成「被清空」', async () => {
    const plan = planSync(
      { externalKey: 'ORDER-142', url: null, fields: {}, lastChange: null },
      ctx({ aposSide: {}, lastSyncedValues: {} }),
    );
    expect(plan.actions).toHaveLength(0);
  });
});

describe('循环同步抑制（§11）', () => {
  /**
   * ★ 完整走一遍循环最容易发生的路径：
   *   我们回写 → 适配器把 originTag 落到外部 → 下一轮拉回来。
   *   漏判的话这一轮会把自己刚写的值当成「外部修改」再处理一次。
   */
  it('★ 回写后再拉取，自己写的那次变更被识别为回声并计数', async () => {
    await jira.writeField(CONN, 'ORDER-142', 'status', 'reviewing', TAG);
    const obj = await jira.fetchObject(CONN, 'ORDER-142');

    const plan = planSync(
      obj!,
      ctx({
        aposSide: {
          status: { value: 'reviewing', changedAt: '', changedBy: '系统', actorType: 'system' },
        },
        lastSyncedValues: { status: 'executing' },
      }),
    );

    expect(plan.echoes).toBeGreaterThan(0);
    expect(plan.actions.find((a) => a.field === 'status')).toBeUndefined();
  });

  /**
   * ★ 两个 APOS 项目连同一个 Jira 项目时，各自的标记必须不同 ——
   *   否则 A 项目会把 B 项目写的变更当成自己的回声丢掉，
   *   而那是静默的数据丢失，最难查的一类。
   */
  it('★ 另一个 APOS 项目写的变更不是我的回声', async () => {
    await jira.writeField(CONN, 'ORDER-142', 'status', 'reviewing', originTagFor('proj-2'));
    const obj = await jira.fetchObject(CONN, 'ORDER-142');

    const plan = planSync(
      obj!,
      ctx({
        aposSide: {
          status: { value: 'executing', changedAt: '', changedBy: '系统', actorType: 'system' },
        },
        lastSyncedValues: { status: 'executing' },
      }),
    );

    expect(plan.echoes).toBe(0);
    expect(plan.actions.find((a) => a.field === 'status')).toBeDefined();
  });
});

describe('外部对象被删除（§11）', () => {
  it('★ 只打标不产生任何字段动作 —— 本地数据不跟着删', async () => {
    await jira.externalDelete('ORDER-142');
    const obj = await jira.fetchObject(CONN, 'ORDER-142');
    const plan = planSync(obj!, ctx());

    expect(plan.externalDeleted).toBe(true);
    expect(plan.actions).toHaveLength(0);
  });
});

describe('同步基准的推进', () => {
  it('对齐了的字段推进基准', async () => {
    await jira.externalEdit('ORDER-142', 'assignee', '王强', '李娜', 'x');
    const obj = await jira.fetchObject(CONN, 'ORDER-142');
    const plan = planSync(obj!, ctx());

    const next = nextSyncedValues(plan, { assignee: '张伟' });
    expect(next['assignee']).toBe('王强');
  });

  /**
   * ★ 冲突字段的基准必须不动。
   *   写进去的话下一轮会认为「两边都没动过」，冲突从此消失，
   *   而两边的值仍然不同 —— 表现为「同步显示正常但数据对不上」，
   *   并且再也不会自己暴露。
   */
  it('★ 冲突字段的基准不动，否则冲突会在下一轮凭空消失', async () => {
    await jira.externalEdit('ORDER-142', 'status', 'done', '李娜', 'x');
    const obj = await jira.fetchObject(CONN, 'ORDER-142');
    const plan = planSync(
      obj!,
      ctx({
        aposSide: {
          status: { value: 'reviewing', changedAt: '', changedBy: '系统', actorType: 'system' },
        },
        lastSyncedValues: { status: 'executing' },
      }),
    );

    const next = nextSyncedValues(plan, { status: 'executing' });
    expect(next['status']).toBe('executing');
  });
});

describe('权限最小化（§5.2）', () => {
  it('★ 合并 PR 永远在禁止项里，不是一个可以打开的开关', async () => {
    const github = new MemoryIntegrationAdapter('github');
    const scopes = await github.grantedScopes(CONN);

    expect(scopes.denied).toContain('merge_pr');
    expect(scopes.allowed).not.toContain('merge_pr');
    // 页面要能回答「它能不能改我的仓库设置」
    expect(scopes.denied).toContain('admin_repo');
  });
});

describe('外部服务不可用（§11）', () => {
  it('测试连接返回可读原因而不是抛异常', async () => {
    jira.failWith('token 已过期');
    const r = await jira.testConnection(CONN);
    expect(r.ok).toBe(false);
    expect(r.message).toBe('token 已过期');
  });

  it('拉取时抛错，由调用方标记异常并暂停同步', async () => {
    jira.failWith('服务不可达');
    await expect(jira.fetchObject(CONN, 'ORDER-142')).rejects.toThrow('服务不可达');
  });
});
