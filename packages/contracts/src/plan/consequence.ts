import { z } from 'zod';

/**
 * 计划批准前那一屏的后果说明 —— 前后端共享的结构化形态。
 *
 * ★★ 为什么这一片必须是码而不是服务端拼好的句子：
 *
 *   「批准之后哪些事会不经二次确认自动发生」是**人类闸门上最要紧的一段话**，
 *   里面含「将自动创建 Pull Request（对外可见）」这种一旦发生就收不回的动作。
 *   它此前是三条中文模板字符串，于是英文界面上整块是中文 —— 看不懂它的人，
 *   点下 Approve 时并不知道自己授权了什么。
 *
 *   按 CLAUDE.md 的判据数消费者：中文界面、英文界面、以及旁边那个
 *   「Adjust these rules → policy settings」入口，三占其二，必须是码 + 参数。
 *
 *   The pre-approval consequence list is the most safety-critical copy in the
 *   product: it is what a person consents to. Shipping it as a pre-built
 *   Chinese sentence left the English UI unreadable at exactly that moment.
 *
 * ★ 参数里带的是**用户/Agent 产出的内容**（任务标题、Policy 名）。它们原样
 *   透传，不翻译 —— 把用户起的名字「翻译」一遍等于给它改名。
 */

/** 批准后会自动发生的事 / What happens automatically once approved */
export const AutoActionCode = z.enum([
  /** N 个任务将由 Agent 自动执行。params: { count, titles } */
  'agents_execute',
  /** 预计消耗多少 token。params: { tokens, percent? } */
  'token_estimate',
  /** 将自动创建 Pull Request（对外可见） */
  'pull_request_create',
]);
export type AutoActionCode = z.infer<typeof AutoActionCode>;

/** 仍然需要人的那一条为什么在 / Why a step still needs a person */
export const HumanGateCode = z.enum([
  /** 这活得人干，不是审批闸 */
  'execution_required',
  /** 某条 Policy 要求人工介入。params: { policy } */
  'policy_requires_human',
  /** 项目自治等级下该风险等级需人工确认。params: { risk } */
  'autonomy_requires_confirm',
]);
export type HumanGateCode = z.infer<typeof HumanGateCode>;

/**
 * 接下来系统会怎么处理这道闸 / What the system will do with this gate.
 *
 * ★ 与上面的 code 分开：「为什么需要人」和「系统接下来怎么办」是两个问题。
 *   取值对齐 Policy 的 action 类型 —— 那才是真正决定「接下来发生什么」的东西。
 *
 * ★ 收件人（角色名）走 params 原样带过去：`role` 可能是用户自建的项目角色，
 *   翻译它等于改名。
 */
export const AssigneeHintCode = z.enum([
  /** 项目成员（不由 Policy 决定，是「这活得人干」那一类的默认） */
  'project_member',
  'auto_allow',
  'auto_notify',
  'agent_review',
  'human_review',
  'multiple_approvals',
  'ask',
  'pause',
  'deny',
  'escalate',
  'transfer_to_human',
]);
export type AssigneeHintCode = z.infer<typeof AssigneeHintCode>;

/**
 * 码之外还要带的参数。
 *
 * ★ 只允许字符串与数字：这些值最终要进 i18n 的占位符替换，
 *   而对象进去之后渲染出来的是 `[object Object]` —— 那是个只会在
 *   某个语言的某一条词条上出现的 bug，最难被发现。
 */
export const ConsequenceParams = z.record(z.union([z.string(), z.number()]));
export type ConsequenceParams = z.infer<typeof ConsequenceParams>;
