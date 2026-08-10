import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { Modal } from './ManualMoveDialog';

/**
 * 手工建任务。
 *
 * ★★ 在此之前工作项只能被**生成**出来：唯一的创建路径是
 *   `需求 → analyze → 计划 → 批准 → 分解成任务`。那条链是产品的核心
 *   （两道 Human Gate 都在上面），但它同时让「随手记一个 bug」
 *   在系统里做不到 —— 而那是任何任务系统最高频的一个动作。
 *
 * ★★ 补入口不能把门禁一起补没了：建出来的是**草稿**，不可派发。
 *   要让它跑起来得由有批准权限的人放行（`plan.approve`）。
 *   这一点必须在表单上就说清楚 —— 不说的话，界面上会出现一条
 *   建好了却什么都不发生的任务，而用户看不出缺了哪一步。
 */

const TYPES: { value: string; label: string }[] = [
  { value: 'task', label: '任务' },
  { value: 'bug', label: '缺陷' },
  { value: 'feature', label: '功能' },
  { value: 'story', label: '用户故事' },
  { value: 'research', label: '调研' },
  { value: 'review', label: '评审' },
  { value: 'test', label: '测试' },
  { value: 'incident', label: '故障' },
  { value: 'knowledge', label: '知识条目' },
];

const PRIORITIES: { value: number; label: string }[] = [
  { value: 0, label: 'P0 · 最高' },
  { value: 1, label: 'P1 · 高' },
  { value: 2, label: 'P2 · 中' },
  { value: 3, label: 'P3 · 低' },
];

export function CreateWorkItemDialog({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('task');
  const [priority, setPriority] = useState(2);
  const [riskLevel, setRiskLevel] = useState('low');
  const qc = useQueryClient();

  const create = useMutation({
    mutationFn: () =>
      api.createWorkItem(projectId, {
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        type,
        priority,
        riskLevel,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.boardAll(projectId) });
      // 执行图按 layout 分了多份缓存，用前缀一次全作废
      await qc.invalidateQueries({ queryKey: ['graph', projectId] });
      onClose();
    },
  });

  return (
    <Modal onClose={onClose}>
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">新建任务</h2>

        <label className="block">
          <span className="text-xs font-medium text-slate-700">标题</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="订单导出接口偶发超时"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>

        <div className="grid grid-cols-3 gap-2">
          <label className="block">
            <span className="text-xs font-medium text-slate-700">类型</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
            >
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-700">优先级</span>
            <select
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
            >
              {PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-700">风险</span>
            <select
              value={riskLevel}
              onChange={(e) => setRiskLevel(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
              <option value="critical">极高</option>
            </select>
          </label>
        </div>

        <label className="block">
          <span className="text-xs font-medium text-slate-700">
            描述
            <span className="ml-1 font-normal text-slate-400">选填</span>
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>

        {/*
          ★★ 这句话不是提示，是这个入口能存在的**条件**。
            手工建的任务如果建完就能派发，任何能建任务的人都可以让 Agent
            去做任意事情 —— 两道 Human Gate 就都被绕开了。
        */}
        <p className="rounded bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800">
          手工建的任务不经过「需求 → 计划 → 批准」那条链，所以会先落成
          <strong>草稿</strong>，不会被派发。要让它进入待执行队列，
          需要有批准权限的人（tech_lead）放行一次 —— 门禁的粒度从
          「批一份计划」变成「批一个任务」，而不是没有门禁。
        </p>

        {create.error instanceof ApiError && (
          <p className="text-xs text-rose-600">{create.error.message}</p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-300 px-3 py-1.5 text-xs"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!title.trim() || create.isPending}
            onClick={() => create.mutate()}
            className="rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {create.isPending ? '创建中…' : '创建草稿'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
