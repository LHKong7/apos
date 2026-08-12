import { useState } from 'react';
import clsx from 'clsx';
import type { Stage, WorkItemStatus } from '@apos/contracts';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { stageLabel, statusLabel } from '../../lib/format';
import type { BoardCard } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** 原因分类进 Analytics 的「人工覆盖率」，自由文本没法聚合 */
const REASONS = [
  { value: 'review_found_issue', label: '审核发现问题，需返工' },
  { value: 'requirement_changed', label: '需求变更' },
  { value: 'system_misjudged', label: '系统状态判断有误' },
  { value: 'other', label: '其他' },
] as const;

interface Props {
  card: BoardCard;
  toStatus: WorkItemStatus;
  toStage: Stage;
  onCancel: () => void;
  onConfirm: (input: { reason: string; reasonCategory: string; terminateRun: boolean }) => void;
  pending?: boolean;
  error?: string | null;
}

/**
 * 手动移动确认框（页面文档 05 §5.6）。
 *
 * 强制填原因不是形式主义：这条原因会记进 Event 并标注「人类覆盖」，
 * Analytics 的「人工覆盖率」指标全靠它。这个指标衡量的是
 * 系统自动判断的准确性，应该随时间下降 —— 没有原因就只剩一个干巴巴的数字，
 * 没法回答「为什么被覆盖」。
 */
export function ManualMoveDialog({
  card,
  toStatus,
  toStage,
  onCancel,
  onConfirm,
  pending,
  error,
}: Props) {
  const [category, setCategory] = useState<string>(REASONS[0].value);
  const [other, setOther] = useState('');
  const [terminateRun, setTerminateRun] = useState(false);

  const label = REASONS.find((r) => r.value === category)?.label ?? '';
  const reason = category === 'other' ? other.trim() : label;
  const canSubmit = reason.length > 0 && !pending;
  const hasRunningRun = card.runStatus === 'running' || card.status === 'executing';

  return (
    <Modal onClose={onCancel} title="手动调整任务状态">
      <h2 className="text-sm font-semibold text-slate-900">
        将「{card.title}」从 {stageLabel(card.stage)} 移到 {stageLabel(toStage)}
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        目标状态 {statusLabel(toStatus)} · 该操作会记入事件并标注「人类覆盖」
      </p>

      <fieldset className="mt-3 space-y-1.5">
        <legend className="text-xs font-medium text-slate-700">原因</legend>
        {REASONS.map((r) => (
          <label key={r.value} className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="radio"
              name="reason"
              value={r.value}
              checked={category === r.value}
              onChange={() => setCategory(r.value)}
              className="accent-slate-900"
            />
            {r.label}
            {r.value === 'other' && (
              <Input
                type="text"
                value={other}
                onChange={(e) => {
                  setOther(e.target.value);
                  setCategory('other');
                }}
                placeholder="请说明"
                className="ml-1 flex-1" />
            )}
          </label>
        ))}
      </fieldset>

      {hasRunningRun && (
        <label className="mt-3 flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={terminateRun}
            onChange={(e) => setTerminateRun(e.target.checked)}
            className="accent-slate-900"
          />
          同时终止正在运行的 Agent Run
        </label>
      )}

      {error && (
        <p className="mt-3 rounded bg-red-50 px-2 py-1.5 text-xs text-red-700">{error}</p>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" size="sm"
          onClick={onCancel}>
          取消
        </Button>
        <Button variant="neutral" size="sm"
          disabled={!canSubmit}
          onClick={() => onConfirm({ reason, reasonCategory: category, terminateRun })}>
          {pending ? '提交中…' : '确认'}
        </Button>
      </div>
    </Modal>
  );
}


/**
 * 居中弹层。全站五处共用（新建组织 / 新建任务 / Run 控制 / 批准计划 / 要求修改）。
 *
 * ★★ 底层换成了 shadcn Dialog（Radix），签名只多了一个可选的 `title` ——
 *   五个调用点原样能跑。
 *
 *   手写版本缺的东西一条都不会报错，只是键盘和读屏用户用不了：
 *   - 焦点没有移进弹层，Tab 会跑到背后的页面上
 *   - 关闭后焦点不归位，键盘用户得从头 Tab 一遍
 *   - 没有 Esc 关闭（原来连这条都没有，只能点遮罩）
 *   - 背景内容没有 aria-hidden，读屏器会把整页念一遍
 *   - body 没有锁滚动，弹层开着还能滚背后的看板
 *
 * ★ `title` 是给读屏器的。Radix 强制要求 DialogTitle —— 没有它，
 *   读屏用户听到的是「对话框」三个字，不知道弹出来的是什么。
 *   调用方自己画的那个 <h2> 只是视觉上的标题，读屏器不认。
 */
/**
 * 宽度档位。
 *
 * ★ 做成档位而不是让调用方自己传 `w-[560px]`：那样写出来的宽度会**超过**
 *   DialogContent 的 max-w-md，于是要么被裁掉、要么横向溢出，而调用方看到的
 *   现象是「我设了宽度但没变宽」。宽度必须由弹层自己定，才可能同时改到那个上限。
 */
const MODAL_WIDTH = {
  md: 'max-w-md',
  /** 表单类：两列布局、JSON 文本框这些在 md 下太挤 */
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
} as const;

export function Modal({
  children,
  onClose,
  title = '对话框',
  footer,
  width = 'md',
}: {
  children: React.ReactNode;
  onClose: () => void;
  /** 读屏器播报用。调用方通常自己画了可见标题，所以这里默认隐藏 */
  title?: string;
  /**
   * 常驻底栏，通常是取消/保存。
   *
   * ★ 它在滚动区**外面** —— 表单再长，按钮也一直在那儿。
   *   放进滚动区的代价是实测出来的：Agent 配置表单在 780px 高的窗口上
   *   内容有 1555px，「保存」按钮落在 y=1620，而可视区只到 683 ——
   *   得往下滚将近一千像素才够得着，中途还很容易以为这个弹层坏了。
   */
  footer?: React.ReactNode;
  width?: keyof typeof MODAL_WIDTH;
}) {
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        hideClose
        className={clsx('gap-0 p-0', MODAL_WIDTH[width])}
        // 这些弹层的说明文字形态各异，交给调用方自己写，不套 DialogDescription
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {/*
          ★ min-h-0 不能省。flex 子项默认 min-height:auto，不加的话它不肯
            缩到内容高度以下，overflow-y-auto 永远不触发 —— 弹层照样被撑高，
            等于上面那个 max-height 白加了。
        */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {footer && (
          <div className="shrink-0 border-t border-border bg-card px-5 py-3">{footer}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
