import { useT, type MessageKey } from '../../lib/i18n';
import { joinList, policyOperationLabel } from '@/lib/format';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, api } from '../../lib/api/client';
import type { OperationSwitchResponse, SimulationResponse } from '../../lib/api/types';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import { SimulationView } from './SimulationView';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * 翻一个开关前的确认（P1）。
 *
 * ★★ 一键操作最危险的地方不是它做错事，是它**看起来什么都没做**。
 *
 *   这个弹窗要回答三个问题，缺一个都不行：
 *   1. 这一下会往库里加什么 —— 一条规则，人话写出来（`explanation`）；
 *   2. 放开一类操作会不会与历史上的人类判断相悖 —— 模拟，与手写规则同一份闸；
 *   3. 切完之后这一行**真的**变了没有 —— 服务端保存后重新体检的结论。
 *
 *   第 3 点是这个弹窗与普通「保存成功」提示的根本区别：规则存下来了不等于
 *   这一行变成了用户要的状态。别的规则、或者安全底线，都可能仍然拦在前面。
 *   报「已保存」就收工，用户会以为自己放开了，实际没有 ——
 *   而这种误解只会在出事的时候才被发现。
 *
 * Confirming a switch. A one-click control's real danger is looking like it did
 * nothing, so this answers three questions: what rule gets written, whether
 * loosening contradicts past human judgment (the same simulation gate a
 * hand-written rule goes through), and — crucially — whether the row actually
 * changed afterward. A saved rule is not the same as a changed row.
 */
const TEMPLATES = {
  auto: 'auto_approve_for_operation',
  human: 'require_human_for_operation',
} as const;

const ANY_ENVIRONMENT = 'any';
const ENVIRONMENTS = [ANY_ENVIRONMENT, 'production', 'staging', 'test', 'dev'] as const;

export function OperationSwitchDialog({
  projectId,
  operationType,
  verdict,
  onClose,
  onDone,
}: {
  projectId: string;
  operationType: string;
  verdict: 'auto' | 'human';
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const t = useT();
  const [environment, setEnvironment] = useState<string>(ANY_ENVIRONMENT);
  const [simulation, setSimulation] = useState<SimulationResponse | null>(null);
  const [needsAck, setNeedsAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OperationSwitchResponse | null>(null);

  const operation = policyOperationLabel(operationType);
  /**
   * ★★ 限定了环境时，「这一行仍然是视情况」是**预期结果**，不是失败。
   *
   *   只放开生产部署，其余环境照旧走原来的规则 —— 整行的判定当然是
   *   「视情况」。按整行判成功与否的话，用户每次限定环境都会看到一句
   *   「规则已保存，但它没生效」，而他要的正是这个结果。
   *   一个把成功报成失败的提示，比不提示更糟：用户会把它改回去。
   */
  const scoped = environment !== ANY_ENVIRONMENT;
  const scopedAsIntended = (res: OperationSwitchResponse) =>
    scoped && res.outcome?.verdict === 'depends';

  /**
   * ★ 模板 → 条件/动作的映射只在后端有一份实现。前端跟着算一遍就有两份，
   *   迟早对不上 —— 而这一页对不上的后果是「弹窗里写的规则」
   *   和「实际存进去的规则」不是同一条。
   */
  const built = useQuery({
    queryKey: ['operationSwitchDraft', projectId, operationType, verdict, environment],
    queryFn: () =>
      api.buildFromTemplate(projectId, TEMPLATES[verdict], {
        operationType,
        environment,
        approver: 'tech_lead',
        dueInHours: 8,
      }),
  });

  const apply = useMutation({
    mutationFn: (acknowledge: boolean) =>
      api.setOperationSwitch(projectId, {
        operationType,
        verdict,
        environment,
        name: t(`policy.switch.ruleName.${verdict}` as MessageKey, { operation }),
        acknowledgeMismatches: acknowledge,
      }),
    onSuccess: (res) => {
      setResult(res);
      setError(null);
      // ★ 真的变了才关窗；没变的话把原因摊开，让用户读完自己决定下一步
      if (res.applied) onDone(t('policy.switch.applied', { operation }));
      else if (scopedAsIntended(res)) {
        onDone(
          t('policy.switch.appliedScoped', {
            operation,
            env: t(`policy.switch.env.${environment}` as MessageKey),
          }),
        );
      }
    },
    onError: (e) => {
      if (
        e instanceof ApiError &&
        (e.details as { requiresAcknowledgment?: boolean })?.requiresAcknowledgment
      ) {
        setSimulation((e.details as { simulation: SimulationResponse }).simulation);
        setNeedsAck(true);
        setError(e.message);
        return;
      }
      setError(e instanceof ApiError ? e.message : t('policy.actionFailed'));
    },
  });

  return (
    <Modal onClose={onClose} title={t('policy.switch.dialogTitle')} width="lg">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">
          {t(`policy.switch.heading.${verdict}` as MessageKey, { operation })}
        </h2>

        <Label htmlFor="switch-scope" className="mt-3 block text-xs text-slate-600">
          {t('policy.switch.scope')}
        </Label>
        <Select value={environment} onValueChange={setEnvironment}>
          <SelectTrigger id="switch-scope" className="mt-0.5 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ENVIRONMENTS.map((env) => (
              <SelectItem key={env} value={env}>
                {t(`policy.switch.env.${env}` as MessageKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-0.5 text-[11px] text-slate-400">{t('policy.switch.scopeHint')}</p>

        {/* ★ 这一下会往库里加什么，用人话写出来 —— 与实际存进去的是同一份 */}
        {built.data && (
          <div className="mt-3 rounded bg-slate-50 px-2 py-1.5">
            <p className="text-[11px] text-slate-500">{t('policy.switch.willCreate')}</p>
            <p className="mt-0.5 text-xs leading-5 text-slate-700">{built.data.explanation}</p>
            <p className="mt-1 text-[11px] text-slate-400">{t('policy.switch.reversible')}</p>
          </div>
        )}

        {simulation && (
          <div className="mt-3 rounded border border-slate-200 p-2">
            <h3 className="text-xs font-medium text-slate-700">{t('rule.validate')}</h3>
            <SimulationView result={simulation} />
          </div>
        )}

        {/*
          ★★ 保存完之后这一行真的变了没有 —— 这块比「已保存」重要得多。
            没变的两种成因分开说：被别的规则挡住（用户改得动，去看那几条），
            和安全底线不许（用户改不动，任何配置都放行不了）。
            混成一句「没生效」的话，前者他找不到该看哪儿，后者他会一直试下去。
        */}
        {result && !result.applied && !scopedAsIntended(result) && (
          <div className="mt-3 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
            <p className="font-medium">
              {t('policy.switch.notApplied', {
                operation,
                state: t(
                  result.outcome?.verdict === 'auto'
                    ? 'policy.auto'
                    : result.outcome?.verdict === 'human'
                      ? 'policy.needsHuman'
                      : 'policy.dependsOn',
                ),
              })}
            </p>
            <p className="mt-0.5 text-[11px]">
              {result.blockedBy === 'other_rules'
                ? t('policy.switch.blocked.other_rules', {
                    rules: joinList(result.shadowedBy.map((p) => p.name)),
                  })
                : result.blockedBy === 'safety_floor'
                  ? t('policy.switch.blocked.safety_floor')
                  : t('policy.switch.blocked.autonomy_default')}
            </p>
          </div>
        )}

        {error && <p className="mt-2 rounded bg-red-50 px-2 py-1.5 text-xs text-red-800">{error}</p>}

        <div className="mt-3 flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            onClick={onClose}
            className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-xs text-slate-500 hover:text-slate-800"
          >
            {result && !result.applied && !scopedAsIntended(result)
              ? t('common.gotIt')
              : t('common.cancel')}
          </Button>
          <Button
            variant="neutral"
            size="sm"
            onClick={() => apply.mutate(needsAck)}
            disabled={
              apply.isPending ||
              !built.data ||
              (result !== null && !result.applied && !scopedAsIntended(result))
            }
          >
            {needsAck ? t('rule.enableAnyway') : t('policy.switch.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
