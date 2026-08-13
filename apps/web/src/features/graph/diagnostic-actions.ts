import { t } from '../../lib/i18n';
import type { DiagnosticAction } from '@apos/domain';

/**
 * 诊断动作的落点解析（页面文档 07 §5.8）。
 *
 * ★ 这一层单独拎出来，是因为「诊断动作通向哪里」是会悄悄坏掉的东西：
 *   动作按钮长得都一样，点下去没反应或者弹一句「尚未实现」，
 *   在截图和冒烟里都看不出区别——而 §5.8 的要求恰恰是
 *   「每条诊断带一个可执行动作，不做只诊断不给方案的提示」。
 *   拎出来就能被断言：每一种 kind 都必须有去处。
 */
export type DiagnosticIntent =
  /** 换页（react-router 跳转，不能整页刷新——那会断掉 SSE） */
  | { kind: 'navigate'; to: string }
  /** 就地打开 Work Item 抽屉 */
  | { kind: 'open-card'; nodeId: string }
  /** 催办某条决策 */
  | { kind: 'remind'; nodeId: string }
  /** 明确告诉用户此路不通以及该走哪条路——只用于 MVP 有意不做的能力 */
  | { kind: 'explain'; message: string };

export function resolveDiagnosticAction(
  action: DiagnosticAction,
  projectId: string,
): DiagnosticIntent {
  switch (action.kind) {
    case 'remind':
      return action.nodeId
        ? { kind: 'remind', nodeId: action.nodeId }
        : { kind: 'navigate', to: `/projects/${projectId}/decisions` };

    case 'reassign':
    case 'split':
      // 改派与拆分都在 Work Item 抽屉里做，不用换页
      return action.nodeId
        ? { kind: 'open-card', nodeId: action.nodeId }
        : { kind: 'navigate', to: `/projects/${projectId}/board` };

    case 'locate':
      // ★「定位」要真的定位到那张卡。只跳到看板首页等于让用户自己再找一遍，
      //   在 66 张卡的看板上这个动作基本等于没有
      return {
        kind: 'navigate',
        to: action.nodeId
          ? `/projects/${projectId}/board?card=${action.nodeId}`
          : `/projects/${projectId}/board`,
      };

    case 'adjust_policy':
      return { kind: 'navigate', to: `/projects/${projectId}/settings/policies` };

    case 'adjust_dependency':
      // MVP 执行图只读（页面文档 07 §5.7）。这是**有意**不做，
      // 所以给的不是「尚未实现」，而是改依赖真正该走的那条路
      return {
        kind: 'explain',
        message: t('graph.readOnlyMvp'),
      };
  }
}
