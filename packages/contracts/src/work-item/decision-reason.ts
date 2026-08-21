import { z } from 'zod';

/**
 * 决策卡片上那两句话的结构化形态 / Structured decision rationale.
 *
 * ★★ 决策中心上「为什么需要你」与「不处理会怎样」此前是服务端拼好的中文。
 *   英文界面上于是长成这样：
 *
 *     If ignored: 任务无法进入「待执行」（无下游任务受影响）
 *
 *   —— 英文的前缀套着中文的正文，中间还夹着中文引号。半句翻译比不翻译更糟：
 *   它让人以为这是没做完的功能，而不是「这段是原始数据」（问题记录 #34）。
 *
 * ★ 这里只结构化**系统生成**的那部分。用户自己起的 Policy 名、
 *   Agent 自己写的求助理由是用户数据，不翻译也不该翻译 ——
 *   它们作为 `params` 原样带过去。
 *
 * Half-translated sentences are worse than untranslated ones: they read as a
 * broken feature rather than as raw data. Only system-generated prose is coded
 * here; user-authored policy names travel through as params.
 */

export const WhyHumanCode = z.enum([
  /** 命中了某条 Policy，它要求人工介入 */
  'policy_requires_human',
  /** 没命中具体 Policy，是项目自治等级对这个风险档位的要求 */
  'autonomy_requires_human',
  /** Agent 自己举手求助 */
  'agent_requested_help',
  /** 产出需要人评审 */
  'review_required',
  /** 恢复策略把这类失败升级给人 */
  'recovery_escalated',
]);
export type WhyHumanCode = z.infer<typeof WhyHumanCode>;

export const ConsequenceCode = z.enum([
  /** 卡在这里，还有 N 个下游任务跟着等 */
  'stalled_with_downstream',
  /** 卡在这里，没有下游受影响 */
  'stalled_alone',
  /** 停在评审阶段 */
  'stuck_in_review',
  /** 停在失败状态 */
  'stuck_failed',
]);
export type ConsequenceCode = z.infer<typeof ConsequenceCode>;

const Coded = <T extends z.ZodTypeAny>(code: T) =>
  z.object({
    code,
    params: z.record(z.union([z.string(), z.number()])).optional(),
  });

export const DecisionReason = z.object({
  whyHuman: Coded(WhyHumanCode).nullable().default(null),
  consequence: Coded(ConsequenceCode).nullable().default(null),
  /**
   * 被决策的那个工作项的标题，**未经加工**。
   *
   * ★★ 决策的 `title` 列存的是平台拼好的一句话（`「X」—— 需要你确认`）。
   *   那个后缀是**平台自己写的词**，因此必须可翻译；而工作项标题是
   *   用户/Agent 产出的内容，必须原样透传（翻译它等于给它改名）。
   *   两者拼在一起入库之后就再也分不开了 —— 英文界面上只能整句照搬中文。
   *
   * ★ 存量决策没有这一栏，界面回落到 `title` 那句拼好的中文。
   *
   * The raw work item title, so the UI can compose "<title> — needs you" in
   * the reader's language instead of inheriting a pre-assembled Chinese one.
   */
  /**
   * ★ optional 而不是必填：另外三条产生决策的路径（恢复升级、复核、
   *   Agent 求助）本来就没有「工作项标题 + 后缀」这种拼法，强制它们填
   *   一个 null 只是噪音。取不到时界面回落到 `title`。
   */
  subjectTitle: z.string().nullable().optional(),
});
export type DecisionReason = z.infer<typeof DecisionReason>;
