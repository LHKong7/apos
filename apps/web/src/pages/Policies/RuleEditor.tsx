import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { FactKey } from '@apos/contracts';
import { FACT_LABELS } from '@apos/domain';
import { ApiError, api } from '../../lib/api/client';
import type { PolicyRow, PolicyTemplateRow, SimulationResponse } from '../../lib/api/types';
import { Modal } from '../../features/work-item/ManualMoveDialog';

/**
 * 规则编辑（页面文档 13 §4.2 / §5.7）。
 *
 * ★ 页面文档 §12.1 的建议是「MVP 只做模板化配置，不做自由条件编辑器，
 *   把省下的资源投入模拟功能」。这里照做了，理由不是省事：
 *   真正需要设定 Agent 边界的是项目负责人。给他一个条件表达式编辑器，
 *   他要么不敢配、要么配错 —— 两种结果都比「只有六个模板」糟糕。
 *
 * ★ 模拟是本页最重要的功能：没有模拟，用户不敢放开自动化；
 *   不放开自动化，产品价值就打折。所以「用历史数据验证」不是可选步骤 ——
 *   放宽类规则保存时后端会自己跑一遍，发现不一致就拦下来（见 policies.ts）。
 */
export function RuleEditor({
  projectId,
  template,
  editing,
  onClose,
  onSaved,
}: {
  projectId: string;
  template: PolicyTemplateRow | null;
  editing: PolicyRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? template?.name ?? '');
  const [priority, setPriority] = useState(editing?.priority ?? 100);
  const [values, setValues] = useState<Record<string, string | number>>(() =>
    Object.fromEntries((template?.params ?? []).map((p) => [p.key, p.default])),
  );
  const [simulation, setSimulation] = useState<SimulationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsAck, setNeedsAck] = useState(false);

  /**
   * ★ 模板参数 → 条件/动作的映射只在后端有一份实现（domain 的 templates.ts）。
   *   前端跟着算一遍就有两份，迟早对不上 —— 而这一页对不上的后果是
   *   「界面上写的规则」和「实际执行的规则」不是同一条。
   *
   *   顺带拿回人话解释：改一个参数就重新生成一句，
   *   用户能一直看着自己在配的到底是什么（页面文档 §5.6）。
   */
  const built = useQuery({
    queryKey: ['policyDraft', projectId, template?.id, JSON.stringify(values)],
    queryFn: () => api.buildFromTemplate(projectId, template!.id, values),
    enabled: Boolean(template),
  });

  const draft = editing
    ? { condition: editing.condition, action: editing.action, explanation: editing.explanation }
    : built.data ?? null;

  const simulateMut = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error('规则还没准备好');
      return api.simulatePolicy(projectId, {
        condition: draft.condition,
        action: draft.action,
        range: '90d',
      });
    },
    onSuccess: setSimulation,
    onError: (e) => setError(e instanceof ApiError ? e.message : '模拟失败'),
  });

  const save = useMutation({
    mutationFn: (acknowledge: boolean) => {
      if (!draft) throw new Error('规则还没准备好');
      return api.savePolicy(
        projectId,
        {
          name,
          priority,
          condition: draft.condition,
          action: draft.action,
          acknowledgeMismatches: acknowledge,
        },
        editing?.id,
      );
    },
    onSuccess: onSaved,
    onError: (e) => {
      if (e instanceof ApiError && (e.details as { requiresAcknowledgement?: boolean })?.requiresAcknowledgement) {
        // ★ 后端在保存时自己跑了模拟并拦下了 —— 把结果摊开给用户看，
        //   而不是简单地说「保存失败」
        setSimulation((e.details as { simulation: SimulationResponse }).simulation);
        setNeedsAck(true);
        setError(e.message);
        return;
      }
      setError(e instanceof ApiError ? e.message : '保存失败');
    },
  });

  const params = template?.params ?? [];

  return (
    <Modal onClose={onClose}>
      <div className="max-h-[80vh] w-[34rem] max-w-full overflow-y-auto">
        <h2 className="text-sm font-semibold text-slate-900">
          {editing ? `编辑规则「${editing.name}」` : `新建规则 · ${template?.name}`}
        </h2>
        {template && <p className="mt-0.5 text-xs text-slate-500">{template.purpose}</p>}

        <label className="mt-3 block text-xs text-slate-600">
          规则名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
          />
        </label>

        <label className="mt-2 block text-xs text-slate-600">
          优先级
          <input
            type="number"
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
            className="mt-0.5 w-24 rounded border border-slate-300 px-2 py-1 text-xs"
          />
          <span className="ml-2 text-[11px] text-slate-400">
            数字越小越先匹配，命中后停止。组织规则占 1–20
          </span>
        </label>

        {params.length > 0 && (
          <fieldset className="mt-3 rounded border border-slate-200 p-2">
            <legend className="px-1 text-xs font-medium text-slate-700">参数</legend>
            <div className="space-y-2">
              {params.map((p) => (
                <label key={p.key} className="block text-xs text-slate-600">
                  {p.label}
                  {p.hint && <span className="ml-1 text-[11px] text-slate-400">{p.hint}</span>}
                  {p.type === 'number' ? (
                    <span className="mt-0.5 flex items-center gap-1">
                      <input
                        type="number"
                        value={values[p.key] ?? p.default}
                        onChange={(e) => setValues((v) => ({ ...v, [p.key]: Number(e.target.value) }))}
                        className="w-28 rounded border border-slate-300 px-2 py-1 text-xs"
                      />
                      {p.suffix && <span className="text-[11px] text-slate-400">{p.suffix}</span>}
                    </span>
                  ) : (
                    <select
                      value={String(values[p.key] ?? p.default)}
                      onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
                      className="mt-0.5 block w-full rounded border border-slate-300 px-2 py-1 text-xs"
                    >
                      {p.options?.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {/*
          ★ 实时人话解释（§5.6）。用模板拼接，不用大模型 ——
            解释与实际执行逻辑必须严格一致，模型生成的偏差会直接
            导致用户误配规则，而治理功能上的偏差不可接受。
        */}
        {draft && (
          <div className="mt-3 rounded bg-slate-50 px-2 py-1.5">
            <p className="text-[11px] text-slate-500">📝 这条规则的意思是</p>
            <p className="mt-0.5 text-xs leading-5 text-slate-700">{draft.explanation}</p>
            {editing && (
              <p className="mt-1 text-[11px] text-slate-400">
                MVP 只支持改名称、优先级与启停。条件与动作要改就重新从模板创建 ——
                自由条件编辑留到有人真的被模板卡住时再做
              </p>
            )}
          </div>
        )}

        {/* ── 模拟：本页最重要的功能 ── */}
        <div className="mt-3 rounded border border-slate-200 p-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-medium text-slate-700">🧪 用历史数据验证</h3>
            <button
              type="button"
              onClick={() => simulateMut.mutate()}
              disabled={simulateMut.isPending || !draft}
              className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {simulateMut.isPending ? '模拟中…' : '运行模拟'}
            </button>
          </div>

          {simulation ? (
            <SimulationView result={simulation} />
          ) : (
            <p className="mt-1 text-[11px] text-slate-400">
              拿这条规则到过去 90 天的真实评估上跑一遍，看它会自动处理多少次、
              其中多少次与人类当时的判断不一致
            </p>
          )}
        </div>

        {error && (
          <p className="mt-2 rounded bg-red-50 px-2 py-1.5 text-xs text-red-800">{error}</p>
        )}

        <div className="mt-3 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="text-xs text-slate-500 hover:text-slate-800">
            取消
          </button>
          <button
            type="button"
            onClick={() => save.mutate(needsAck)}
            disabled={!name || save.isPending || !draft}
            className="rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {needsAck ? '我知道风险，仍然启用' : save.isPending ? '保存中…' : '启用规则'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * 模拟结果（§5.7）。
 *
 * ★ 「其中 N 次人类当时是驳回的」比任何说明都更能帮用户发现规则漏洞。
 *   所以这块的排版把不一致案例放在最显眼的位置，
 *   而不是先报一串「会自动处理 47 次」的好消息。
 */
function SimulationView({ result }: { result: SimulationResponse }) {
  const CONFIDENCE = { high: '样本充足', medium: '样本一般', low: '样本偏少' } as const;

  return (
    <div className="mt-1.5 space-y-1.5 text-xs">
      <p className="text-slate-600">
        过去的 {result.totalSamples} 次评估里，这条规则会自动处理{' '}
        <span className="font-medium">{result.wouldAutoHandle}</span> 次
        <span className="ml-1 text-[11px] text-slate-400">（{CONFIDENCE[result.confidence]}）</span>
      </p>

      {result.mismatches.length > 0 ? (
        <div className="rounded bg-amber-50 px-2 py-1.5">
          <p className="font-medium text-amber-900">
            ⚠ 其中 {result.mismatches.length} 个任务，人类当时是驳回或要求修改的
          </p>
          <ul className="mt-1 space-y-0.5">
            {result.mismatches.slice(0, 5).map((m) => (
              <li key={m.eventId} className="text-[11px] text-amber-900">
                · {m.occurredAt.slice(0, 10)} {m.workItemTitle}
                {m.humanNote && <span className="text-amber-700">（{m.humanNote}）</span>}
              </li>
            ))}
          </ul>
          {result.suggestions.length > 0 && (
            <p className="mt-1 text-[11px] text-amber-900">
              💡 建议增加排除条件：
              {result.suggestions
                .map((s) => `${FACT_LABELS[s.addCondition.fact as FactKey] ?? s.addCondition.fact} ≠ ${String(s.addCondition.value)}`)
                .join('、')}
              <span className="ml-1 text-amber-700">
                （基于 {result.suggestions[0]!.wouldEliminate} 个案例的统计模式，不是因果结论，请人工确认）
              </span>
            </p>
          )}
        </div>
      ) : (
        <p className="rounded bg-green-50 px-2 py-1 text-[11px] text-green-900">
          ✓ 没有发现与人类判断不一致的历史案例
        </p>
      )}

      {/* ★ 局限必须说出来。模拟基于历史事件回放，上下文缺失时会有偏差 */}
      {result.caveats.length > 0 && (
        <ul className="space-y-0.5">
          {result.caveats.map((c) => (
            <li key={c} className="text-[11px] text-slate-400">
              · {c}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

