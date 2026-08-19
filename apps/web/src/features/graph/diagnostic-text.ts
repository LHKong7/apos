import { hasMessage, useT, type MessageKey } from '@/lib/i18n';
import type { Diagnostic, DiagnosticAction } from '@apos/domain';

/**
 * 图诊断的说法 / Wording for graph diagnostics.
 *
 * ★★ 诊断正文与按钮说法此前是 domain 层拼好的中文，一路显示到执行图与
 *   总览上。英文界面上的结果是同一行里两种语言并排：
 *
 *     「现状分析与方案调研」已阻塞 16.2h，下游 4 个任务在等，占关键路径 10%
 *     [ 改派 ] [ 在看板中定位 ] [ Locate in graph (5 nodes affected) ]
 *
 *   前两个按钮来自 domain，第三个来自前端 i18n。现在 domain 给码 + 参数，
 *   说法在这里定。
 *
 * ★ 认不出的码回落到服务端那句中文，**不是空白**：诊断区空一行等于
 *   「这条诊断不存在」，而它其实存在，只是前端还没跟上新码。
 *
 * The domain layer emits codes and params; the wording lives here.
 */
export function useDiagnosticText() {
  const t = useT();

  return {
    message(d: Diagnostic): string {
      const key = `diag.msg.${d.messageCode}` as MessageKey;
      return hasMessage(key) ? t(key, d.params) : d.message;
    },
    action(a: DiagnosticAction): string {
      const key = `diag.action.${a.labelCode}` as MessageKey;
      return hasMessage(key) ? t(key) : a.label;
    },
  };
}
