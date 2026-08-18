import { z } from 'zod';

/**
 * 阻塞原因的结构化形态 —— 前后端共享 / Structured block reasons.
 *
 * ★★ 为什么服务端不直接给一句话：这句话有三个消费者 —— 中文界面、
 *   英文界面，和界面上那个「一键修复」按钮。拼好的中文只服务第一种，
 *   另外两种只能反过来正则匹配它，而匹配一句随时会改的话是定时炸弹。
 *   CLAUDE.md 里记的「服务端报错仍是中文」这个缺口，指的就是这里。
 *
 *   A pre-built sentence serves only the Chinese UI; the English UI and the
 *   "fix this" button would have to pattern-match prose that is free to change.
 *   `reason` stays as the fallback for logs and older clients.
 */

/** 一个候选 Agent 被淘汰的原因码。与 domain/flow/matching.ts 的 RejectionCode 同构 */
export const RejectionCode = z.enum([
  'human_executor',
  'not_project_member',
  'agent_inactive',
  'runtime_not_registered',
  'type_not_applicable',
  'at_capacity',
  'missing_capabilities',
  'missing_tools',
  'missing_resources',
  'daily_token_exhausted',
  'per_run_token_exceeded',
]);
export type RejectionCode = z.infer<typeof RejectionCode>;

/**
 * 这条限制配在哪一层。
 *
 * ★★ 存在的唯一理由是消灭一类自相矛盾的展示：Agent 档案页写着
 *   「允许 write_file」，看板上却说「缺少 write_file」。两句都对 ——
 *   档案说的是组织级上限，看板说的是项目级授权。不标层级，用户看到的
 *   就是系统在自打嘴巴（问题记录 #6）。
 */
export const RejectionScope = z.enum(['project', 'org', 'platform', 'work_item']);
export type RejectionScope = z.infer<typeof RejectionScope>;

/**
 * 修复这条限制要去哪儿。
 *
 * ★ 界面据此渲染一个直达按钮。`none` 表示用户改不了（平台层），
 *   这时候不给按钮 —— 给一个点了没用的按钮比不给更糟。
 */
export const RejectionFix = z.enum([
  /** 成员与角色：把这个 Agent 加进项目 */
  'add_project_member',
  /** 项目级 Agent 授权：补能力 / 工具 / 资源 */
  'grant_project_access',
  /** 组织级 Agent 设置：改状态、类型、并发、额度 */
  'edit_agent',
  /** 任务本身：改执行方式 */
  'edit_work_item',
  'none',
]);
export type RejectionFix = z.infer<typeof RejectionFix>;

/** 原因码 → 修复入口。全站只此一份，免得界面各处各猜一套 */
export const FIX_FOR_CODE: Record<RejectionCode, RejectionFix> = {
  human_executor: 'edit_work_item',
  not_project_member: 'add_project_member',
  agent_inactive: 'edit_agent',
  runtime_not_registered: 'none',
  type_not_applicable: 'edit_agent',
  at_capacity: 'none',
  missing_capabilities: 'grant_project_access',
  missing_tools: 'grant_project_access',
  missing_resources: 'grant_project_access',
  daily_token_exhausted: 'edit_agent',
  per_run_token_exceeded: 'edit_agent',
};

export const RejectedCandidate = z.object({
  agentId: z.string(),
  agentName: z.string(),
  code: RejectionCode,
  scope: RejectionScope,
  /** 插值参数，键名对应词条里的 `{name}` */
  params: z.record(z.union([z.string(), z.number()])).optional(),
});
export type RejectedCandidate = z.infer<typeof RejectedCandidate>;

/** 阻塞的大类。候选级的细节挂在 `candidates` 上 */
export const BlockedKind = z.enum([
  /** 有候选，但一个都过不了闸 */
  'no_matching_agent',
  /** 项目里压根没有 Agent */
  'no_agents_in_project',
  /** 工作区准备不出来 */
  'workspace_unavailable',
  /** 说不出细节的兜底，只有 reason 字符串可用 */
  'other',
]);
export type BlockedKind = z.infer<typeof BlockedKind>;

export const BlockedDetail = z.object({
  kind: BlockedKind,
  candidates: z.array(RejectedCandidate).default([]),
  /** 兜底细节（工作区报错等），已经是一句话，界面原样显示 */
  detail: z.string().nullable().default(null),
  /** 写入时刻，用于判断这份细节是不是过期了 */
  at: z.string().datetime().optional(),
});
export type BlockedDetail = z.infer<typeof BlockedDetail>;

/**
 * 两份阻塞细节是不是「同一件事」。
 *
 * ★★ 调度器每 5 秒扫一轮，同一个原因会被反复写。不做这个判断的话
 *   Timeline 上会堆出几十条一模一样的 `work_item.blocked`，
 *   而真正有意义的状态变更被淹掉（问题记录 #43）；
 *   更糟的是 `blockedSince` 跟着一起刷新，卡片上的阻塞时长永远显示 0m。
 *
 *   The scheduler re-derives this every tick. Without an equality check the
 *   timeline fills with identical blocked events and `blockedSince` keeps
 *   resetting, so the card always reads "blocked 0m".
 */
export function sameBlockedDetail(
  a: BlockedDetail | null | undefined,
  b: BlockedDetail | null | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.kind !== b.kind || a.detail !== b.detail) return false;
  if (a.candidates.length !== b.candidates.length) return false;
  // ★ 按 agentId 排序后比对：候选顺序取决于查询计划，不是语义的一部分
  const key = (c: RejectedCandidate) =>
    `${c.agentId}|${c.code}|${JSON.stringify(c.params ?? {})}`;
  const left = a.candidates.map(key).sort();
  const right = b.candidates.map(key).sort();
  return left.every((v, i) => v === right[i]);
}
