/**
 * 批量批准的资格判定。
 *
 * ★ 这条判定必须前后端共用一份 —— 和集成权限那条（permissions/integration.ts）
 *   是同一个理由：界面上灰掉的按钮和服务端真正拦住的请求，得是同一条规则。
 *
 * ★ 为什么它非存在不可：页面文档要求决策中心能「5 分钟清空队列」，
 *   但队列里混着「合并 PR」和「删生产库数据」时，一个全选框本身就是事故。
 *   批量的价值在于省掉重复点击，不在于省掉阅读 ——
 *   所以只有**低风险且可逆**的决策可以批量放行，其余必须逐条确认。
 *
 * ★ 这条判定原先只写在前端（Decisions 页的 isBatchable），服务端的
 *   batch-approve 拿到 id 就照批。也就是说「不给勾选框」只是视觉上的克制，
 *   不是约束：直接调 API、或者用一个旧版本的前端，就能把不可逆的
 *   高风险操作一次性批掉。灰按钮不是权限。
 */
export interface BatchCandidate {
  /** 当前身份对这条决策有没有处置权（责任不可代行） */
  canAct: boolean;
  /** 批错了能不能撤回 */
  reversible: boolean;
  riskLevel: string;
}

export const NON_BATCHABLE_RISK = ['high', 'critical'] as const;

export function isBatchable(d: BatchCandidate): boolean {
  return (
    d.canAct &&
    d.reversible &&
    !NON_BATCHABLE_RISK.includes(d.riskLevel as (typeof NON_BATCHABLE_RISK)[number])
  );
}

/** 说清楚为什么这条不能批量 —— 界面和 API 的错误信息都用它，口径一致 */
export function batchDenyReason(d: BatchCandidate): string | null {
  if (isBatchable(d)) return null;
  if (!d.canAct) return '这条决策不由你处置，责任不可代行';
  if (!d.reversible) return '这是不可逆操作，必须逐条确认后再批准';
  return `${d.riskLevel === 'critical' ? '极高' : '高'}风险决策必须逐条确认后再批准`;
}
