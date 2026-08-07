import {
  FIELD_DEFAULTS,
  SOT_PRESETS,
  type ConflictStrategy,
  type SideSnapshot,
  type SotPreset,
  type SourceOfTruth,
  type SyncField,
  type SyncMapping,
} from '@apos/contracts';

/**
 * Source of Truth 求解（页面文档 14 §5.3 / 产品文档 9.1）。
 *
 * ★ 这是整个集成层唯一真正难的地方，难点也不在代码量：
 *   两个系统都能改同一个字段，就必然有一方的修改会被丢掉。
 *   一个集成能不能被信任，取决于它能不能回答三个问题 ——
 *   谁说了算、另一边怎么办、被丢掉的那次修改去哪了。
 *   答不上来的集成，用完一阵子的结果是两边的数据都没人敢信。
 *
 * ★ 所以这个函数只做判定、不做写入，返回一个可被审计的 Resolution。
 *   写入在 API 层，日志与事件也在那里 —— 判定与副作用分开，
 *   才可能给它写出覆盖全部分支的测试。
 */

export interface SyncInput {
  field: SyncField;
  mapping: SyncMapping;
  /** APOS 侧当前值；null 表示这一侧没有值 */
  apos: SideSnapshot | null;
  /** 外部系统侧当前值 */
  external: SideSnapshot | null;
  /**
   * 上次同步成功时两侧的公共值。用来判断「这一侧改过没有」——
   * 只比 apos 与 external 是分不出「谁改的」的：值不同既可能是
   * A 改了，也可能是 B 改了，还可能两边都改了，处理方式完全不同。
   */
  lastSynced: { value: unknown; at: number } | null;
  /**
   * 外部这次变更的来源标记。等于我们自己的 tag 时说明是我们刚写过去的回声。
   * 见 §11「双向同步造成循环更新」。
   */
  externalOriginTag: string | null;
  /** 本系统的写入标记 */
  ownOriginTag: string;
}

export type Resolution =
  /** 两侧一致，什么都不用做 */
  | { kind: 'noop' }
  /** 外部这次变更是我们自己写过去的回声，丢弃（并计入「已阻止 N 次循环同步」）*/
  | { kind: 'echo' }
  /** 采纳外部的值 */
  | { kind: 'accept'; value: unknown }
  /** 采纳外部的值，但要通知负责人 */
  | { kind: 'accept_and_warn'; value: unknown; note: string }
  /** 以 APOS 为准，把 APOS 的值写回外部 */
  | { kind: 'writeback'; value: unknown }
  /** 两侧评论合并 */
  | { kind: 'merge'; value: unknown }
  /** 记录冲突等人处理 */
  | { kind: 'conflict'; apos: SideSnapshot; external: SideSnapshot; sourceOfTruth: SourceOfTruth };

/**
 * 判定一次外部变更该怎么处理。
 *
 * 顺序是刻意的：回声 → 无变化 → 可合并 → 非 SoT 端改动 → SoT 端说了算。
 * 把回声检测放在最前面，是因为它一旦漏判，后面每一步都会在处理一条
 * 根本不存在的「外部修改」，并且很可能再写回去一次 —— 循环就是这么起来的。
 */
export function resolveSync(input: SyncInput): Resolution {
  const { mapping, apos, external, lastSynced } = input;

  // 1. 回声：我们刚写过去的值又被推回来了
  if (input.externalOriginTag !== null && input.externalOriginTag === input.ownOriginTag) {
    return { kind: 'echo' };
  }

  // 2. 两侧一致
  if (same(apos?.value, external?.value)) return { kind: 'noop' };

  // 3. 可合并的字段（评论）不存在「谁说了算」的问题
  if (mapping.sourceOfTruth === 'merge') {
    return { kind: 'merge', value: mergeComments(apos?.value, external?.value) };
  }

  const aposChanged = changedSince(apos, lastSynced);
  const externalChanged = changedSince(external, lastSynced);

  // 4. 只有 SoT 那一侧动了 —— 没有争议，按方向执行
  if (mapping.sourceOfTruth === 'external' && !aposChanged) {
    return external ? { kind: 'accept', value: external.value } : { kind: 'noop' };
  }
  if (mapping.sourceOfTruth === 'apos' && !externalChanged) {
    return apos ? { kind: 'writeback', value: apos.value } : { kind: 'noop' };
  }

  /**
   * 5. 非 SoT 那一侧动了（可能两侧都动了）。这才是策略生效的地方。
   *
   *    ★ 两侧同时改过时，record_conflict 之外的策略也照常执行 ——
   *      「忽略并回写」的语义就是「SoT 赢，另一边的改动被覆盖」，
   *      同时改过并不改变这个结论，只是让它更值得被记一笔。
   *      所以下面无论走哪条分支，调用方都会写一条事件。
   */
  const winner = mapping.sourceOfTruth === 'apos' ? apos : external;
  const loser = mapping.sourceOfTruth === 'apos' ? external : apos;

  switch (mapping.strategy) {
    case 'record_conflict':
      // 两侧都得有值才谈得上冲突；缺一侧就退化成普通的单边变更
      if (!apos || !external) break;
      return { kind: 'conflict', apos, external, sourceOfTruth: mapping.sourceOfTruth };

    case 'accept_and_warn':
      if (!loser) break;
      return {
        kind: 'accept_and_warn',
        value: loser.value,
        note: `${sideName(mapping.sourceOfTruth === 'apos' ? 'external' : 'apos')}修改了「${input.field}」，按「接受并告警」策略已采纳`,
      };

    case 'writeback':
    default:
      break;
  }

  if (!winner) return { kind: 'noop' };
  return mapping.sourceOfTruth === 'apos'
    ? { kind: 'writeback', value: winner.value }
    : { kind: 'accept', value: winner.value };
}

/**
 * 「以后同类冲突自动按此处理」的归类键（页面文档 14 §5.3 末尾那个勾选框）。
 *
 * ★ 同类 = 同一个集成的同一个字段，不含具体对象。
 *   把对象 id 算进去，这个勾选框就只对同一条 Issue 的下一次冲突生效 ——
 *   而用户勾它的时候想表达的显然是「这个字段以后别再问我」。
 */
export function similarityKey(integrationId: string, field: SyncField): string {
  return `${integrationId}:${field}`;
}

/** 冲突集中在哪个字段，说明那个字段的 SoT 默认值配错了（页面文档 14 §10 埋点） */
export function conflictHotspots(
  conflicts: { field: SyncField }[],
): { field: SyncField; count: number; hint: string }[] {
  const byField = new Map<SyncField, number>();
  for (const c of conflicts) byField.set(c.field, (byField.get(c.field) ?? 0) + 1);

  return [...byField.entries()]
    .map(([field, count]) => ({
      field,
      count,
      hint: `${count} 次冲突集中在这个字段 —— 通常说明它的 Source of Truth 配反了`,
    }))
    .sort((a, b) => b.count - a.count);
}

/** 预设 → 逐字段映射。策略保留用户已有的选择，预设只动 SoT。 */
export function applyPreset(preset: SotPreset, current: SyncMapping[]): SyncMapping[] {
  const fields = SOT_PRESETS[preset].fields as Record<SyncField, SourceOfTruth>;
  const strategyOf = new Map(current.map((m) => [m.field, m.strategy]));

  return (Object.keys(fields) as SyncField[]).map((field) => ({
    field,
    sourceOfTruth: fields[field],
    strategy: strategyOf.get(field) ?? defaultStrategy(field),
  }));
}

/** 当前配置匹配哪个预设；都不匹配就是自定义 */
export function matchPreset(mappings: SyncMapping[]): SotPreset | null {
  const actual = new Map(mappings.map((m) => [m.field, m.sourceOfTruth]));

  for (const [name, preset] of Object.entries(SOT_PRESETS)) {
    const fields = preset.fields as Record<SyncField, SourceOfTruth>;
    const hit = (Object.keys(fields) as SyncField[]).every(
      (f) => actual.get(f) === fields[f],
    );
    if (hit) return name as SotPreset;
  }
  return null;
}

export function defaultMappings(): SyncMapping[] {
  return (Object.keys(FIELD_DEFAULTS) as SyncField[]).map((field) => ({
    field,
    sourceOfTruth: FIELD_DEFAULTS[field].sourceOfTruth,
    strategy: defaultStrategy(field),
  }));
}

/**
 * ★ 状态字段默认「记录冲突」而不是默认「回写」。
 *
 *   状态是唯一一个会驱动流程往下走的字段：悄悄把它回写回去，
 *   外部系统里那个人看到自己刚点的「Done」被弹回 Review，
 *   而且没有任何解释。别的字段被覆盖只是数据不一致，
 *   状态被覆盖是「这个系统在跟我较劲」。
 */
function defaultStrategy(field: SyncField): ConflictStrategy {
  return field === 'status' ? 'record_conflict' : 'writeback';
}

function sideName(side: 'apos' | 'external'): string {
  return side === 'apos' ? 'APOS' : '外部系统';
}

function changedSince(side: SideSnapshot | null, last: { value: unknown; at: number } | null): boolean {
  if (!side) return false;
  if (!last) return true; // 没有同步基准，只能当作改过
  return !same(side.value, last.value);
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 评论合并：按 externalId 去重后按时间排序。
 *
 * ★ 去重键用外部 id 而不是内容 —— 两个人先后说了同一句「收到」是两条评论，
 *   而同一条评论被两侧各拉了一次是一条。按内容去重会把前者吃掉一条。
 */
function mergeComments(a: unknown, b: unknown): unknown {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];

  const byId = new Map<string, Record<string, unknown>>();
  for (const c of [...left, ...right]) {
    if (typeof c !== 'object' || c === null) continue;
    const row = c as Record<string, unknown>;
    const id = String(row['externalId'] ?? row['id'] ?? JSON.stringify(row));
    if (!byId.has(id)) byId.set(id, row);
  }

  return [...byId.values()].sort(
    (x, y) => String(x['createdAt'] ?? '').localeCompare(String(y['createdAt'] ?? '')),
  );
}
