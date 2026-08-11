import { useState } from 'react';
import { Modal } from '../work-item/ManualMoveDialog';
import type { RunControlAction } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  action: Extract<RunControlAction, 'terminate' | 'add_constraint'>;
  runtimeName: string;
  onCancel: () => void;
  onConfirm: (input: { reason?: string; constraint?: string }) => void;
  pending: boolean;
  error: string | null;
  /** 能力不支持时后端给出的替代动作 */
  fallback?: string | null;
}

/**
 * 运行时控制确认框（页面文档 09 §5.1）。
 *
 * 追加约束是个轻量但重要的能力：用户看到 Agent 走偏时的第一反应
 * 往往是「提醒它一句」，而不是终止重来。没有这个入口，
 * 每次走偏都要付出重跑一遍的成本，人就会倾向于放任不管。
 */
export function RunControlDialog({
  action,
  runtimeName,
  onCancel,
  onConfirm,
  pending,
  error,
  fallback,
}: Props) {
  const [text, setText] = useState('');
  const isTerminate = action === 'terminate';
  const canSubmit = text.trim().length > 0 && !pending;

  return (
    <Modal onClose={onCancel} title="Run 控制">
      <h2 className="text-sm font-semibold text-slate-900">
        {isTerminate ? '终止这次执行' : '向执行中的 Agent 追加约束'}
      </h2>

      <p className="mt-1 text-xs text-slate-500">
        {isTerminate
          ? '终止不可恢复。已产生的产物会保留，并标注「来自未完成的 Run」。'
          : `${runtimeName} 将在当前步骤结束后应用该约束，已完成的步骤不会回滚。`}
      </p>

      <label className="mt-3 block">
        <span className="mb-0.5 block text-[11px] text-slate-500">
          {isTerminate ? '终止原因（必填，会记入事件）' : '约束内容'}
        </span>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder={
            isTerminate ? '需求已作废，不必继续' : '例如：仅修改 order-service，不要动 shared-lib'
          }
        />
      </label>

      {error && (
        <div className="mt-3 rounded bg-red-50 px-2 py-1.5 text-xs text-red-700">
          <p>{error}</p>
          {/* 能力不足时直接告诉用户下一步能做什么，而不是只说「不支持」 */}
          {fallback && <p className="mt-1 text-red-600">{fallback}</p>}
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" size="sm"
          onClick={onCancel}>
          取消
        </Button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() =>
            onConfirm(isTerminate ? { reason: text.trim() } : { constraint: text.trim() })
          }
          className={
            isTerminate
              ? 'rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40'
              : 'rounded bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-40'
          }
        >
          {pending ? '提交中…' : isTerminate ? '确认终止' : '发送'}
        </button>
      </div>
    </Modal>
  );
}
