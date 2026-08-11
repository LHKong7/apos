import clsx from 'clsx';

/**
 * 品牌标记。
 *
 * ★ 形状就是执行图的缩影：两条上游任务汇进一个人类决策点，再继续往下流。
 *   产品那一句话（项目自己往前流，关键节点上有人）在这里是一个图形，
 *   和 public/favicon.svg 同源 —— 标签页里和界面里认出来的是同一个东西。
 *
 * ★ 单独成文件而不是留在 App.tsx：登录页也要用它，
 *   而登录页正是 App.tsx 引进来的 —— 反过来再引一次就成了循环依赖。
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={clsx(
        'relative inline-flex shrink-0 items-center justify-center rounded-md',
        'bg-gradient-to-br from-brand-alt via-brand to-brand-far shadow-sm',
        className ?? 'h-6 w-6',
      )}
    >
      <svg viewBox="0 0 32 32" className="h-[70%] w-[70%]" aria-hidden>
        <g stroke="rgb(255 255 255 / 0.85)" strokeWidth="2.2" strokeLinecap="round" fill="none">
          <path d="M9 9 L16 16" />
          <path d="M23 9 L16 16" />
          <path d="M16 16 L16 24" />
        </g>
        <circle cx="9" cy="9" r="3" fill="#fff" fillOpacity="0.9" />
        <circle cx="23" cy="9" r="3" fill="#fff" fillOpacity="0.9" />
        <circle cx="16" cy="16" r="3.6" fill="#fff" />
        <circle cx="16" cy="25" r="2.6" fill="#fff" fillOpacity="0.9" />
      </svg>
    </span>
  );
}
