import { useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import {
  FIX_FOR_CODE,
  type BlockedDetail,
  type RejectedCandidate,
  type RejectionFix,
  type RejectionScope,
} from '@apos/contracts';
import { useT, type MessageKey } from '@/lib/i18n';
import { Button } from '@/components/ui/button';

/**
 * 「为什么卡住了」—— 结构化阻塞原因 / Structured block reasons.
 *
 * ★★ 这里替换的是一行由服务端拼好的长句：
 *   「无匹配 Agent：refactor-agent（不是本项目成员 …）；review-agent-1（…）；…」
 *   六条原因、六条建议，压成一行，中英文标点混着走，而真正的下一步动作
 *   被埋在第三个分号后面。用户得在脑子里把它解析成六个失败模式。
 *   （问题记录 #2 / #12 / #25 / #34）
 *
 * ★★ 每条都标**层级**。Agent 档案页写着「允许 write_file」而看板说
 *   「缺少 write_file」，两句都对 —— 一个是组织级上限，一个是项目级授权。
 *   不标层级，用户看到的就是系统在自打嘴巴（#6），然后跑去改错地方。
 *
 * ★ 同类原因归并成一个按钮。四个 Agent 都因为「不是本项目成员」被拒时，
 *   要修的是一处不是四处 —— 按钮上写清楚它一次管几个（#12 的批量修复）。
 *
 * Replaces one server-built run-on sentence with a per-agent list that names
 * the layer each limit lives at, and offers one deep link per distinct fix.
 */

/** 原因码 → 图标。用图标把失败模式分成几类，扫一眼就知道是哪一类 */
const CODE_ICON: Record<string, string> = {
  human_executor: '👤',
  not_project_member: '👥',
  agent_inactive: '⚠️',
  runtime_not_registered: '🔌',
  type_not_applicable: '🏷️',
  at_capacity: '⏳',
  missing_capabilities: '🔧',
  missing_tools: '🔧',
  missing_resources: '📦',
  daily_token_exhausted: '💤',
  per_run_token_exceeded: '💤',
};

const SCOPE_STYLE: Record<RejectionScope, string> = {
  project: 'bg-sky-50 text-sky-700',
  org: 'bg-violet-50 text-violet-700',
  platform: 'bg-slate-100 text-slate-600',
  work_item: 'bg-amber-50 text-amber-800',
};

/** 一次最多摊开几条 —— 再多就折起来，长列表本身也是噪声 */
const COLLAPSE_AFTER = 4;

export function BlockedReasons({
  projectId,
  detail,
  fallback,
  className,
}: {
  projectId: string;
  detail: BlockedDetail | null | undefined;
  /** 老数据 / 说不出细节时的兜底句 */
  fallback?: string | null;
  className?: string;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  /**
   * ★ 没有结构化细节时**原样显示那句话**，不假装没有阻塞。
   *   这一区在存量数据上必须还能读 —— 迁移前写进库的 blockedReason
   *   是唯一记录，丢掉它等于把历史阻塞原因抹了。
   */
  if (!detail) {
    if (!fallback) return null;
    return <p className={clsx('text-[11px] text-slate-500', className)}>{fallback}</p>;
  }

  const candidates = detail.candidates ?? [];
  const shown = expanded ? candidates : candidates.slice(0, COLLAPSE_AFTER);

  return (
    <div className={clsx('space-y-1', className)}>
      <p className="text-[11px] font-medium text-slate-700">
        {t(`blocked.kind.${detail.kind}` as MessageKey, { count: candidates.length })}
      </p>

      {detail.detail && <p className="text-[11px] text-slate-500">{detail.detail}</p>}

      {candidates.length > 0 && (
        <ul className="space-y-0.5">
          {shown.map((c) => (
            <li key={`${c.agentId}-${c.code}`} className="flex flex-wrap items-baseline gap-1.5">
              {/* ★ emoji 一律 aria-hidden，语义由旁边的层级徽标与文字承担（#19） */}
              <span aria-hidden className="text-[11px]">
                {CODE_ICON[c.code] ?? '⛔'}
              </span>
              <span className="text-[11px] font-medium text-slate-800">{c.agentName}</span>
              <span
                className={clsx(
                  'rounded px-1 text-[10px] leading-4',
                  SCOPE_STYLE[c.scope] ?? SCOPE_STYLE.platform,
                )}
                title={t(`blocked.scopeHint.${c.scope}` as MessageKey)}
              >
                {t(`blocked.scope.${c.scope}` as MessageKey)}
              </span>
              <span className="min-w-0 flex-1 text-[11px] text-slate-600">
                {t(`blocked.reason.${c.code}` as MessageKey, c.params ?? {})}
              </span>
            </li>
          ))}
        </ul>
      )}

      {candidates.length > COLLAPSE_AFTER && (
        <Button
          variant="ghost"
          size="xs"
          className="h-auto px-0 text-[11px] font-normal text-slate-500 underline hover:bg-transparent"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded
            ? t('blocked.showLess')
            : t('blocked.showAll', { count: candidates.length - COLLAPSE_AFTER })}
        </Button>
      )}

      <FixActions projectId={projectId} candidates={candidates} />
    </div>
  );
}

/**
 * 修复入口。
 *
 * ★★ 按**修复动作**归并，不按 Agent。四个 Agent 都不在项目里时，
 *   要去的是同一个「成员与角色」页 —— 给四个一模一样的按钮，
 *   等于让用户点四次去同一个地方，还以为要修四处。
 *
 * ★ `none` 的那些（运行时没注册、满载）不给按钮：给一个点了没用的按钮
 *   比不给更糟，用户会以为自己点错了。
 */
function FixActions({
  projectId,
  candidates,
}: {
  projectId: string;
  candidates: RejectedCandidate[];
}) {
  const t = useT();

  const groups = new Map<RejectionFix, RejectedCandidate[]>();
  for (const c of candidates) {
    const fix = FIX_FOR_CODE[c.code] ?? 'none';
    if (fix === 'none') continue;
    const list = groups.get(fix) ?? [];
    list.push(c);
    groups.set(fix, list);
  }
  if (groups.size === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 pt-0.5">
      {[...groups.entries()].map(([fix, list]) => (
        <Button key={fix} asChild variant="outline" size="xs">
          <Link to={fixHref(projectId, fix, list)}>
            {list.length > 1
              ? t(`blocked.fixMany.${fix}` as MessageKey, { count: list.length })
              : t(`blocked.fix.${fix}` as MessageKey, { name: list[0]!.agentName })}
          </Link>
        </Button>
      ))}
    </div>
  );
}

/**
 * ★ 只有一个目标时把 `agent=` 带上，落地页会把那一张卡片展开 ——
 *   否则用户到了设置页还得在一列 Agent 里再找一遍它叫什么。
 */
function fixHref(projectId: string, fix: RejectionFix, list: RejectedCandidate[]): string {
  const only = list.length === 1 ? list[0]!.agentId : null;
  const base = `/projects/${projectId}/settings`;
  switch (fix) {
    case 'add_project_member':
      return `${base}/members?add=agent`;
    case 'grant_project_access':
      return `${base}/agents?tab=binding${only ? `&agent=${only}` : ''}`;
    case 'edit_agent':
      return `${base}/agents?tab=agents${only ? `&agent=${only}` : ''}`;
    case 'edit_work_item':
    case 'none':
      return `${base}/agents`;
  }
}

/**
 * 卡片上那一行的压缩说法 / One-line summary for the board card.
 *
 * ★★ 卡片放不下六条原因，但也不能因此退回那句拼好的长句 ——
 *   在窄列里它会被 `line-clamp-2` 截成半截话（问题记录 #25）。
 *   压缩的办法是**归并同类**：六个 Agent 里四个是同一个原因时，
 *   卡片上该说的是「4 个 Agent 不是本项目成员」，剩下的进详情。
 *
 * Cards cannot hold six reasons, and the run-on sentence gets clipped
 * mid-word in a narrow column. Collapse by code instead: name the dominant
 * cause and how many agents share it.
 */
export function useBlockedSummary(): (
  detail: BlockedDetail | null | undefined,
  fallback: string | null | undefined,
) => string {
  const t = useT();
  return (detail, fallback) => {
    if (!detail) return fallback ?? t('card.reasonNotRecorded');
    if (detail.kind === 'workspace_unavailable') {
      return detail.detail ?? t('blocked.kind.workspace_unavailable');
    }
    const candidates = detail.candidates ?? [];
    if (candidates.length === 0) {
      return t(`blocked.kind.${detail.kind}` as MessageKey, { count: 0 });
    }

    const byCode = new Map<string, RejectedCandidate[]>();
    for (const c of candidates) {
      byCode.set(c.code, [...(byCode.get(c.code) ?? []), c]);
    }
    // ★ 最大的那一类就是「主要原因」—— 修掉它能一次解开最多候选
    const [code, list] = [...byCode.entries()].sort((a, b) => b[1].length - a[1].length)[0]!;
    const head = t(`blocked.reason.${code}` as MessageKey, list[0]!.params ?? {});
    const rest = candidates.length - list.length;

    const lead =
      list.length === 1
        ? t('blocked.summary.one', { name: list[0]!.agentName, reason: head })
        : t('blocked.summary.many', { count: list.length, reason: head });
    return rest > 0 ? t('blocked.summary.andMore', { lead, count: rest }) : lead;
  };
}
