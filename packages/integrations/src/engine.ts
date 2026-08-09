import type { SideSnapshot, SyncField, SyncMapping } from '@apos/contracts';
import { resolveSync, type Resolution } from '@apos/domain';
import type { ExternalObject } from './adapter';

/**
 * 一次同步的判定结果。
 *
 * ★ 引擎只算不写：把「该做什么」和「做」分开，是因为写入涉及事务、
 *   事件、状态机，而判定必须能被单独测到每一个分支。
 *   两件事揉在一起的同步引擎，测试只能靠起一个真数据库跑端到端 ——
 *   而端到端跑不出「两侧同时改了 status 且策略是接受并告警」这种组合。
 */
export interface SyncPlan {
  externalKey: string;
  /** 外部对象已被删除：本地打标，不删数据 */
  externalDeleted: boolean;
  actions: FieldAction[];
  /** 被识别为自身回声而丢弃的字段数，用于「已阻止 N 次循环同步」 */
  echoes: number;
}

export interface FieldAction {
  field: SyncField;
  resolution: Resolution;
}

export interface SyncContext {
  mappings: SyncMapping[];
  /** APOS 侧的当前值与最后修改者 */
  aposSide: Partial<Record<SyncField, SideSnapshot>>;
  /** 上次同步成功时的公共值 */
  lastSyncedValues: Record<string, unknown>;
  lastSyncedAt: number | null;
  ownOriginTag: string;
}

/**
 * 为一个外部对象算出这次该做什么。
 *
 * ★ 逐字段判定，不整对象判定。整对象比较会把「只有负责人变了」
 *   放大成「整条记录冲突」，而负责人的 SoT 是外部、状态的 SoT 是 APOS ——
 *   两个字段的归属不同，合在一起就没法处理了。
 */
export function planSync(external: ExternalObject, ctx: SyncContext): SyncPlan {
  if (external.deleted) {
    return { externalKey: external.externalKey, externalDeleted: true, actions: [], echoes: 0 };
  }

  const actions: FieldAction[] = [];
  let echoes = 0;

  for (const mapping of ctx.mappings) {
    const field = mapping.field;
    const externalValue = external.fields[field];

    // 这个字段外部侧根本没有对应物（比如 Slack 没有截止时间），跳过
    if (externalValue === undefined && ctx.aposSide[field] === undefined) continue;

    const resolution = resolveSync({
      field,
      mapping,
      apos: ctx.aposSide[field] ?? null,
      external:
        externalValue === undefined
          ? null
          : {
              value: externalValue,
              changedAt: external.lastChange?.at ?? '',
              changedBy: external.lastChange?.by ?? '未知',
              actorType: 'external',
            },
      lastSynced:
        ctx.lastSyncedAt === null || !(field in ctx.lastSyncedValues)
          ? null
          : { value: ctx.lastSyncedValues[field], at: ctx.lastSyncedAt },
      externalOriginTag: external.lastChange?.originTag ?? null,
      ownOriginTag: ctx.ownOriginTag,
    });

    if (resolution.kind === 'echo') {
      echoes += 1;
      continue;
    }
    if (resolution.kind === 'noop') continue;

    actions.push({ field, resolution });
  }

  return { externalKey: external.externalKey, externalDeleted: false, actions, echoes };
}

/**
 * 这次同步之后应该记住的公共值。
 *
 * ★ 只有真正对齐了的字段才更新基准。
 *   把冲突字段也写进基准，下一轮就会认为「两边都没动过」——
 *   冲突从此消失，两边的值却仍然不同。这类 bug 表现为
 *   「同步显示正常，但数据对不上」，且再也不会自己发现。
 */
export function nextSyncedValues(
  plan: SyncPlan,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...previous };

  for (const a of plan.actions) {
    switch (a.resolution.kind) {
      case 'accept':
      case 'writeback':
      case 'merge':
      case 'accept_and_warn':
        next[a.field] = a.resolution.value;
        break;
      case 'conflict':
        // 冲突未解决，基准保持不动
        break;
      default:
        break;
    }
  }

  return next;
}
