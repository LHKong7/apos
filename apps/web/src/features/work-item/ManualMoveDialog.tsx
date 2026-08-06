import { useState } from 'react';
import type { Stage, WorkItemStatus } from '@apos/contracts';
import { statusLabel } from '../../lib/format';
import type { BoardCard } from '../../lib/api/types';

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
    <Modal onClose={onCancel}>
      <h2 className="text-sm font-semibold text-slate-900">
        将「{card.title}」从 {stageName(card.stage)} 移到 {stageName(toStage)}
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
              <input
                type="text"
                value={other}
                onChange={(e) => {
                  setOther(e.target.value);
                  setCategory('other');
                }}
                placeholder="请说明"
                className="ml-1 flex-1 rounded border border-slate-300 px-2 py-0.5 text-xs"
              />
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
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
        >
          取消
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => onConfirm({ reason, reasonCategory: category, terminateRun })}
          className="rounded bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-40"
        >
          {pending ? '提交中…' : '确认'}
        </button>
      </div>
    </Modal>
  );
}

const STAGE_NAMES: Record<Stage, string> = {
  intake: 'Intake',
  planning: 'Planning',
  execution: 'Execution',
  review: 'Review',
  release: 'Release',
  done: 'Done',
};

function stageName(stage: Stage): string {
  return STAGE_NAMES[stage] ?? stage;
}

export function Modal({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg bg-white p-4 shadow-xl"
      >
        {children}
      </div>
    </div>
  );
}
