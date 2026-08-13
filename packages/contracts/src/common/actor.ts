import { z } from 'zod';

/**
 * 系统中的行为主体。产品文档 10.1 定义四类身份，实现上加 `system`。
 *
 * `system` 与 `agent` 必须分开：Flow Engine 按状态机自动推进状态时操作者是
 * `system`，这让审计能区分「规则驱动的确定性行为」与「AI 决策的行为」。
 * 见 docs/tech/09-security.md §1。
 *
 * Who can act in the system. Product doc 10.1 defines four identity kinds; the
 * implementation adds `system`.
 *
 * `system` and `agent` have to stay apart: when the Flow Engine advances a
 * status by the state machine, the operator is `system`. That is what lets an
 * audit tell "deterministic, rule-driven behaviour" from "a decision an AI
 * made" — see docs/tech/09-security.md §1.
 */
export const ActorType = z.enum(['human', 'agent', 'service', 'external', 'system']);
export type ActorType = z.infer<typeof ActorType>;

export const ActorRef = z.object({
  type: ActorType,
  /** `system` 时为 null / null when the actor is `system` */
  id: z.string().uuid().nullable(),
});
export type ActorRef = z.infer<typeof ActorRef>;

export const SYSTEM_ACTOR: ActorRef = { type: 'system', id: null };

export function humanActor(id: string): ActorRef {
  return { type: 'human', id };
}

export function agentActor(id: string): ActorRef {
  return { type: 'agent', id };
}

/**
 * 页面文档 §5.5 的状态来源标识。
 *
 * ★ 前端不读这张表 —— 它走 i18n 词条（lib/i18n 的 `source.*`），才能跟着
 *   界面语言走。这里留着是给**服务端**拼给人看的句子用的。
 *
 *   The frontend does not read this table; it goes through the i18n catalog
 *   (`source.*` in lib/i18n) so the wording follows the selected locale. This
 *   stays for server-side sentence building.
 */
export const ACTOR_SOURCE_LABEL: Record<ActorType, string> = {
  system: '系统',
  agent: 'Agent',
  human: '人类',
  external: '外部同步',
  service: '服务',
};

/** 英文对照；与上表同为 Record<ActorType, string>，新增身份时两边一起编译不过 */
/** English counterpart; same Record type, so a new actor breaks both at build time */
export const ACTOR_SOURCE_LABEL_EN: Record<ActorType, string> = {
  system: 'System',
  agent: 'Agent',
  human: 'Human',
  external: 'External sync',
  service: 'Service',
};
