import { useT } from '../../lib/i18n';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';

import { ApiError, api } from '../../lib/api/client';
import type { PolicyRow, PolicyTemplateRow, SimulationResponse } from '../../lib/api/types';
import { SimulationView } from './SimulationView';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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
  const t = useT();
  const [name, setName] = useState(editing?.name ?? template?.name ?? '');
  /**
   * ★★ 优先级从这里消失了，默认由服务端往后追加。
   *
   *   它要求用户同时理解三件事才填得对：越小越先、命中即停、
   *   组织规则占了前面那一段。而填错的表现是规则安静地不生效 ——
   *   一个填错了不报错、还看不出来的输入框，换来的是一次困惑，
   *   不是一次配置。绝大多数人填完之后也从不回来改它。
   *
   *   `null` = 「按默认排」。真要手动排的人展开「高级」还能改到，
   *   改一条老规则时不动它就保持原样。
   */
  const [priority, setPriority] = useState<number | null>(null);
  const [advanced, setAdvanced] = useState(false);
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
      if (!draft) throw new Error(t('rule.notReady'));
      return api.simulatePolicy(projectId, {
        condition: draft.condition,
        action: draft.action,
        range: '90d',
      });
    },
    onSuccess: setSimulation,
    onError: (e) => setError(e instanceof ApiError ? e.message : t('rule.simulateFailed')),
  });

  const save = useMutation({
    mutationFn: (acknowledge: boolean) => {
      if (!draft) throw new Error(t('rule.notReady'));
      return api.savePolicy(
        projectId,
        {
          name,
          /** ★ 不给 = 新规则往后追加、老规则保持原样。都由服务端定 */
          ...(priority === null ? {} : { priority }),
          condition: draft.condition,
          action: draft.action,
          acknowledgeMismatches: acknowledge,
        },
        editing?.id,
      );
    },
    onSuccess: onSaved,
    onError: (e) => {
      if (e instanceof ApiError && (e.details as { requiresAcknowledgment?: boolean })?.requiresAcknowledgment) {
        // ★ 后端在保存时自己跑了模拟并拦下了 —— 把结果摊开给用户看，
        //   而不是简单地说「保存失败」
        setSimulation((e.details as { simulation: SimulationResponse }).simulation);
        setNeedsAck(true);
        setError(e.message);
        return;
      }
      setError(e instanceof ApiError ? e.message : t('rule.saveFailed'));
    },
  });

  const params = template?.params ?? [];

  return (
    // 宽度与滚动都归 Modal 管：自己再套一层会长出第二根滚动条
    <Modal onClose={onClose} title={t('rule.editor')} width="lg">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">
          {editing ? t('rule.editing', { name: editing.name }) : t('rule.creating', { template: template?.name ?? '' })}
        </h2>
        {template && <p className="mt-0.5 text-xs text-slate-500">{template.purpose}</p>}

        <Label className="mt-3 block text-xs text-slate-600">
          {t('rule.name')}
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-0.5" />
        </Label>


        {params.length > 0 && (
          <fieldset className="mt-3 rounded border border-slate-200 p-2">
            <legend className="px-1 text-xs font-medium text-slate-700">{t('rule.params')}</legend>
            <div className="space-y-2">
              {params.map((p) => (
                <Label key={p.key} className="block text-xs text-slate-600">
                  {p.label}
                  {p.hint && <span className="ml-1 text-[11px] text-slate-400">{p.hint}</span>}
                  {p.type === 'number' ? (
                    <span className="mt-0.5 flex items-center gap-1">
                      <Input
                        type="number"
                        value={values[p.key] ?? p.default}
                        onChange={(e) => setValues((v) => ({ ...v, [p.key]: Number(e.target.value) }))}
                        className="w-28" />
                      {p.suffix && <span className="text-[11px] text-slate-400">{p.suffix}</span>}
                    </span>
                  ) : (
                    <Select
                      value={String(values[p.key] ?? p.default)}
                      onValueChange={(v) => setValues((prev) => ({ ...prev, [p.key]: v }))}
                    >
                      <SelectTrigger className="mt-0.5 w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {p.options?.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Label>
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
            <p className="text-[11px] text-slate-500">{t('rule.meaning')}</p>
            <p className="mt-0.5 text-xs leading-5 text-slate-700">{draft.explanation}</p>
            {editing && (
              <p className="mt-1 text-[11px] text-slate-400">
                {t('rule.editLimits')}
              </p>
            )}
          </div>
        )}

        {/*
          ★ 优先级收进「高级」。露出来的默认是「自动」，不是一个数字 ——
            数字会让人以为自己必须懂它。
        */}
        <div className="mt-2">
          <Button
            variant="ghost"
            onClick={() => setAdvanced((v) => !v)}
            className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-[11px] text-slate-500 underline hover:text-slate-800"
          >
            {advanced ? t('rule.hideAdvanced') : t('rule.advanced')}
          </Button>
          {advanced && (
            <Label className="mt-1 block text-xs text-slate-600">
              {t('rule.priority')}
              <Input
                type="number"
                min={1}
                value={priority ?? editing?.priority ?? ''}
                placeholder={t('rule.priorityAuto')}
                onChange={(e) =>
                  setPriority(e.target.value === '' ? null : Number(e.target.value))
                }
                className="mt-0.5 w-24"
              />
              <span className="ml-2 text-[11px] text-slate-400">{t('rule.priorityHint')}</span>
            </Label>
          )}
        </div>

        {/* ── 模拟：本页最重要的功能 ── */}
        <div className="mt-3 rounded border border-slate-200 p-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-medium text-slate-700">{t('rule.validate')}</h3>
            <Button variant="outline" size="xs"
              onClick={() => simulateMut.mutate()}
              disabled={simulateMut.isPending || !draft}>
              {simulateMut.isPending ? t('rule.simulating') : t('rule.runSimulation')}
            </Button>
          </div>

          {simulation ? (
            <SimulationView result={simulation} />
          ) : (
            <p className="mt-1 text-[11px] text-slate-400">
              {t('rule.simulationHint')}
            </p>
          )}
        </div>

        {error && (
          <p className="mt-2 rounded bg-red-50 px-2 py-1.5 text-xs text-red-800">{error}</p>
        )}

        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-xs text-slate-500 hover:text-slate-800">
            {t('common.cancel')}
          </Button>
          <Button variant="neutral" size="sm"
            onClick={() => save.mutate(needsAck)}
            disabled={!name || save.isPending || !draft}>
            {needsAck ? t('rule.enableAnyway') : save.isPending ? t('common.saving') : t('rule.enable')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
