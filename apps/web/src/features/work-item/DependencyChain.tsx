import { useState } from 'react';
import clsx from 'clsx';
import type { DependencyRef } from '@/lib/api/types';
import { statusLabel } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';

/**
 * 依赖链 —— 「谁挡着我 / 我挡着谁」/ The blocking chain, both directions.
 *
 * ★★ 卡片上此前只有一个「🔗 1」。用户由此知道自己被挡着，但不知道被谁挡着 ——
 *   要弄清「TEST-11 挡着 TEST-12」得挨个点开五张卡去拼拓扑（问题记录 #21）。
 *   一个数字回答不了任何一个后续问题：先做哪个？等谁？催谁？
 *
 * ★★ 两个方向都给。只给上游的话，「先做哪个」仍然答不了 ——
 *   挡住五个人的那条才该先做，而那是**下游**的信息。
 *
 * ★ 不画图。一张 mini graph 在 300px 宽的卡片旁边只能画出三个节点，
 *   而这里要回答的问题（谁、什么状态、点得进去吗）用两个列表就够了。
 *   完整拓扑本来就有专门的一页 —— 执行图。
 */
export function DependencyChain({
  card,
  onOpen,
}: {
  card: { unmetDependencies: number; blockedBy: DependencyRef[]; blocking: DependencyRef[] };
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  const { blockedBy, blocking, unmetDependencies } = card;
  if (blockedBy.length === 0 && blocking.length === 0) return null;

  return (
    <span className="relative">
      <Button
        variant="ghost"
        size="xs"
        aria-expanded={open}
        onClick={(e) => {
          /**
           * ★★ 必须挡住冒泡。整张卡片外层挂着「点开详情」，这个按钮嵌在
           *   里面 —— 不挡的话一次点击同时触发两个 handler，抽屉开了、
           *   气泡也开了，而用户体感是「点了没反应」或者「点错了」。
           *   （问题记录 #30 记的就是这一类坑）
           */
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={clsx(
          'h-auto px-1 py-0 text-[11px] font-normal',
          unmetDependencies > 0 ? 'text-amber-700' : 'text-slate-500',
        )}
        title={t('deps.badgeHint')}
      >
        <span aria-hidden>🔗</span>
        <span className="sr-only">{t('deps.badgeLabel')}</span>
        {unmetDependencies > 0 ? unmetDependencies : blocking.length}
      </Button>

      {open && (
        <div
          className="absolute right-0 top-5 z-20 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <Section
            title={t('deps.blockedBy', { count: blockedBy.length })}
            empty={t('deps.noUpstream')}
            items={blockedBy}
            onOpen={onOpen}
          />
          <Section
            title={t('deps.blocking', { count: blocking.length })}
            empty={t('deps.noDownstream')}
            items={blocking}
            onOpen={onOpen}
            className="mt-1.5 border-t border-slate-100 pt-1.5"
          />
        </div>
      )}
    </span>
  );
}

function Section({
  title,
  empty,
  items,
  onOpen,
  className,
}: {
  title: string;
  empty: string;
  items: DependencyRef[];
  onOpen: (id: string) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{title}</p>
      {items.length === 0 ? (
        <p className="text-[11px] text-slate-400">{empty}</p>
      ) : (
        <ul className="mt-0.5 space-y-0.5">
          {items.map((d) => (
            <li key={d.id}>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => onOpen(d.id)}
                className="h-auto w-full justify-start gap-1.5 px-1 py-0.5 text-left text-[11px] font-normal"
              >
                {/*
                  ★ 满足与否用形状（✓ / ○）而不是只用颜色 ——
                    这一列在色觉障碍下必须还读得出来。
                */}
                <span aria-hidden className={d.met ? 'text-emerald-600' : 'text-amber-600'}>
                  {d.met ? '✓' : '○'}
                </span>
                <span className="font-mono text-slate-400">{d.ref}</span>
                <span className="min-w-0 flex-1 truncate text-slate-700">{d.title}</span>
                <span className="shrink-0 text-slate-400">{statusLabel(d.status)}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
