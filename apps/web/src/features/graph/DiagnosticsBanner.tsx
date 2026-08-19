import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import type { Diagnostic } from '@apos/domain';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { resolveDiagnosticAction } from './diagnostic-actions';
import { useDiagnosticText } from './diagnostic-text';

/**
 * 「问题诊断」的可复用条 / A reusable diagnostics banner.
 *
 * ★★ 这套东西此前只活在执行图那一页。而它是全站最有用的一块 ——
 *   每条问题都带着「改派 / 催办 / 调整 Policy」这类**直达动作**，
 *   而不是像别处那样只报一个状态然后让用户自己想办法（问题记录 #40）。
 *   看板与总览上看到一条阻塞任务时，用户手上一个动作按钮都没有。
 *
 * ★★ 归因那一行同样搬过来：「延期主因：决策等待 5.6d」用一句话说清
 *   「该去解决什么」，比一张数据表管用得多（问题记录 #38）。
 *
 * ★ 只给前几条。总览是指挥台不是问题清单 —— 摊开全部会把这一页
 *   变成第二个执行图，而那一页已经存在了。
 *
 * The one place in the product where a problem comes with the button that
 * fixes it. Everywhere else reports a state and leaves the user to work it out.
 */
export function DiagnosticsBanner({
  projectId,
  diagnostics,
  delayCause,
  onOpenCard,
  onRemind,
  className,
}: {
  projectId: string;
  diagnostics: Diagnostic[];
  /** 延期归因那一行；没有就不画 */
  delayCause?: string | null;
  onOpenCard: (nodeId: string) => void;
  onRemind: (nodeId: string) => void;
  className?: string;
}) {
  const t = useT();
  const say = useDiagnosticText();
  const navigate = useNavigate();

  if (diagnostics.length === 0 && !delayCause) return null;

  const run = (nodeId: string | null | undefined, action: Parameters<typeof resolveDiagnosticAction>[0]) => {
    const intent = resolveDiagnosticAction(action, projectId);
    switch (intent.kind) {
      case 'navigate':
        navigate(intent.to);
        break;
      case 'open-card':
        onOpenCard(intent.nodeId);
        break;
      case 'remind':
        onRemind(intent.nodeId);
        break;
      case 'explain':
        /** ★ 「此路不通」也要说出口 —— 一个点了没反应的按钮比没有按钮更伤 */
        window.alert(intent.message);
        break;
    }
    void nodeId;
  };

  return (
    <section className={clsx('rounded border border-slate-200 bg-white px-3 py-2', className)}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-xs font-medium text-slate-700">
          {t('diag.found', { count: diagnostics.length })}
        </h2>
        {delayCause && (
          <span className="text-[11px] text-slate-600">
            {t('graph.primaryCause', { cause: delayCause })}
          </span>
        )}
        <Button
          variant="ghost"
          size="xs"
          onClick={() => navigate(`/projects/${projectId}/graph`)}
          className="ml-auto h-auto p-0 text-[11px] font-normal text-slate-500 underline hover:bg-transparent"
        >
          {t('diag.seeAll')}
        </Button>
      </div>

      <ul className="mt-1 space-y-1">
        {diagnostics.map((d, i) => (
          <li key={`${d.type}-${i}`} className="flex items-start gap-2 text-xs">
            {/* ★ emoji 只是装饰，严重程度靠颜色与紧随的 sr-only 文字 */}
            <span aria-hidden className={SEVERITY[d.severity].className}>
              {SEVERITY[d.severity].icon}
            </span>
            <span className="sr-only">{t(SEVERITY[d.severity].labelKey)}</span>
            <div className="min-w-0 flex-1">
              <p className={clsx('leading-5', SEVERITY[d.severity].className)}>{say.message(d)}</p>
              <div className="mt-0.5 flex flex-wrap gap-1.5">
                {d.actions.map((action) => (
                  <Button
                    key={`${action.kind}-${action.labelCode}`}
                    variant="outline"
                    size="xs"
                    onClick={() => run(action.nodeId, action)}
                  >
                    {say.action(action)}
                  </Button>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const SEVERITY = {
  critical: { icon: '⛔', className: 'text-red-700', labelKey: 'diag.severity.critical' },
  warning: { icon: '⚠', className: 'text-amber-700', labelKey: 'diag.severity.warning' },
  info: { icon: '💡', className: 'text-slate-600', labelKey: 'diag.severity.info' },
} as const;
