import type { Database } from '@apos/db';
import type { EventBus, PublishedEvent } from '../modules/event/bus';
import { notifyDecisionCreated, type NotifyDeps } from '../modules/notification/service';

/**
 * 通知投递订阅（产品文档十一）。
 *
 * ★ 挂在事件总线上，不是在业务代码里到处调 notify()。
 *   决策可能由 Policy 拦截、Agent 求助、状态机挂起三条路径产生 ——
 *   在每条路径里各加一行发通知，迟早漏掉一条，
 *   而漏掉的表现是「某类决策从来不提醒」，没人会注意到。
 *   订阅事件流则只有一个入口：事件写了就一定会走到这里。
 *
 * ★ 投递失败绝不能影响事务。通知是旁路，发不出去是通知的问题，
 *   不该让一个已经成功的状态流转跟着回滚。
 */
export function startNotificationLoop(
  db: Database,
  bus: EventBus,
  deps: Omit<NotifyDeps, 'db'> & { onError?: (e: unknown) => void },
): () => void {
  const full: NotifyDeps = { db, transports: deps.transports, webBaseUrl: deps.webBaseUrl };

  return bus.subscribeAll(async (event: PublishedEvent) => {
    try {
      if (event.type === 'decision.created') {
        await notifyDecisionCreated(full, event.subjectId);
      }
    } catch (e) {
      // 旁路失败只记录，不抛 —— 抛出去会打断总线上后面的订阅者
      deps.onError?.(e);
    }
  });
}
