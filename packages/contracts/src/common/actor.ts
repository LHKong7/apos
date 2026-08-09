import { z } from 'zod';

/**
 * 系统中的行为主体。产品文档 10.1 定义四类身份，实现上加 `system`。
 *
 * `system` 与 `agent` 必须分开：Flow Engine 按状态机自动推进状态时操作者是
 * `system`，这让审计能区分「规则驱动的确定性行为」与「AI 决策的行为」。
 * 见 docs/tech/09-security.md §1。
 */
export const ActorType = z.enum(['human', 'agent', 'service', 'external', 'system']);
export type ActorType = z.infer<typeof ActorType>;

export const ActorRef = z.object({
  type: ActorType,
  /** `system` 时为 null */
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

/** 页面文档 §5.5 的状态来源标识 */
export const ACTOR_SOURCE_LABEL: Record<ActorType, string> = {
  system: '系统',
  agent: 'Agent',
  human: '人类',
  external: '外部同步',
  service: '服务',
};
