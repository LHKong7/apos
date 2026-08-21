import { useT, type MessageKey } from '../../lib/i18n';
import { policyOperationLabel } from '@/lib/format';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, api } from '../../lib/api/client';
import { usePermissions } from '../../lib/permissions/usePermissions';
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
 * 首次引导（P2）—— 项目一条规则都没有时，列表区变成这个。
 *
 * ★★ 硬编码基线删掉之后，新项目的这一页第一屏是一个**空列表**加一排模板按钮。
 *   那两样东西一起说的是：「这里本该有东西，你自己去配」——
 *   而用户此刻既不知道该配什么，也不知道配多少算够。
 *   于是最常见的结局是关掉页面，项目就这么零规则跑下去；
 *   等出事的时候才发现这里从来没设过边界。
 *
 *   四个问题换一份能用的边界，是这个空状态唯一值得做的事。
 *
 * ★★ 不做成多步向导，就一屏。
 *
 *   分步的代价是用户看不到全貌：他在第 2 步做的选择，要到第 4 步之后才知道
 *   一共换来了什么。而这四个问题彼此独立、都能一眼答完 ——
 *   分步只是把一屏拆成四屏，多按三次「下一步」。
 *
 * ★★ 生成什么，当场列出来，不藏在按钮后面。
 *   一键生成配置最容易变成「我不知道它给我配了什么」，
 *   而治理配置上「不知道自己有什么」和「什么都没有」一样危险。
 *
 * The first-run wizard, shown in place of an empty rule list. With the
 * hard-coded baselines gone, a new project's first screen would otherwise be an
 * empty list next to a row of template buttons — which together say "something
 * belongs here, go work out what", to someone who does not yet know what or how
 * much. Four questions produce a usable boundary instead. One screen rather
 * than four steps, and the rules it will create are listed before you press the
 * button: "I don't know what it configured for me" is as dangerous as having
 * nothing configured.
 */
type ProjectKind = 'software' | 'data' | 'internal';

interface PlannedRule {
  key: string;
  /** 开关矩阵的一行；null = 走模板的预算规则 */
  operationType: string | null;
  environment?: string;
  labelKey: MessageKey;
}

/**
 * 项目类型只做一件事：给下面三个问题一组建议答案。
 *
 * ★ 它不写 `projects.type`，也不影响求值 —— 那是项目设置里的字段，
 *   不该由这一页顺手改掉。这里说的「类型」纯粹是「你大概是哪种项目」，
 *   界面上也照实这么说。
 *
 * ★ 建议答案一律偏保守：高风险操作默认要人批。引导向导给的是起点，
 *   而一个把边界设得太松的起点，用户不会发现 —— 太紧他第二天就来改了。
 */
const PRESETS: Record<ProjectKind, { gateDeploy: boolean; gateDb: boolean; budget: number }> = {
  software: { gateDeploy: true, gateDb: true, budget: 20 },
  data: { gateDeploy: true, gateDb: true, budget: 50 },
  internal: { gateDeploy: true, gateDb: false, budget: 10 },
};

const KINDS: ProjectKind[] = ['software', 'data', 'internal'];

export function FirstRunWizard({
  projectId,
  onDone,
  onSkip,
}: {
  projectId: string;
  onDone: (message: string) => void;
  /** 「我自己来」—— 让出位置给模板排与（空的）规则列表，不是把整块藏掉 */
  onSkip: () => void;
}) {
  const t = useT();
  const perms = usePermissions(projectId);
  const [kind, setKind] = useState<ProjectKind>('software');
  const [gateDeploy, setGateDeploy] = useState(PRESETS.software.gateDeploy);
  const [gateDb, setGateDb] = useState(PRESETS.software.gateDb);
  const [budget, setBudget] = useState<number>(PRESETS.software.budget);
  const [error, setError] = useState<string | null>(null);

  const pickKind = (next: ProjectKind) => {
    setKind(next);
    // 换项目类型 = 换一组建议答案。已经改过的答案也一起重置：
    // 保留一半旧答案的话，屏幕上那份预览就不再对应任何一组建议
    setGateDeploy(PRESETS[next].gateDeploy);
    setGateDb(PRESETS[next].gateDb);
    setBudget(PRESETS[next].budget);
  };

  const planned: PlannedRule[] = [
    ...(gateDeploy
      ? [
          {
            key: 'deploy',
            operationType: 'deploy',
            environment: 'production',
            labelKey: 'policy.wizard.plan.deploy' as MessageKey,
          },
        ]
      : []),
    ...(gateDb
      ? [
          {
            key: 'db_ddl',
            operationType: 'db_ddl',
            labelKey: 'policy.wizard.plan.dbDdl' as MessageKey,
          },
          {
            key: 'db_dml',
            operationType: 'db_dml',
            labelKey: 'policy.wizard.plan.dbDml' as MessageKey,
          },
        ]
      : []),
    ...(budget > 0
      ? [{ key: 'budget', operationType: null, labelKey: 'policy.wizard.plan.budget' as MessageKey }]
      : []),
  ];

  /**
   * ★★ 一条一条**顺序**建，不并发。
   *
   *   每次保存都要把当前规则集整个读一遍（分配优先级、判「有没有放宽组织
   *   规则」、跑模拟）。并发发出去的话，几条请求读到的是同一份旧规则集，
   *   于是它们各自算出的优先级会撞在一起 —— 而撞了之后谁先谁后，
   *   要到很久以后某次判定出乎意料时才会被发现。
   *
   * ★ 中途失败就停下，已经建好的留着。回滚掉反而更糟：用户看到「失败了」，
   *   而库里其实什么都没有，他只能从头再来一遍。
   */
  const generate = useMutation({
    mutationFn: async () => {
      let created = 0;
      for (const rule of planned) {
        if (rule.operationType) {
          await api.setOperationSwitch(projectId, {
            operationType: rule.operationType,
            verdict: 'human',
            ...(rule.environment ? { environment: rule.environment } : {}),
            name: t('policy.switch.ruleName.human', {
              operation: policyOperationLabel(rule.operationType),
            }),
          });
        } else {
          const built = await api.buildFromTemplate(projectId, 'cost-gate', {
            threshold: budget,
            approver: 'tech_lead',
          });
          await api.savePolicy(projectId, {
            name: t('policy.wizard.budgetRuleName', { amount: budget }),
            condition: built.condition,
            action: built.action,
          });
        }
        created += 1;
      }
      return created;
    },
    onSuccess: (created) => onDone(t('policy.wizard.done', { count: created })),
    onError: (e) => setError(e instanceof ApiError ? e.message : t('policy.actionFailed')),
  });

  return (
    <section className="rounded border border-slate-200 bg-white px-3 py-2.5">
      <h2 className="text-xs font-medium text-slate-700">{t('policy.wizard.title')}</h2>
      <p className="mt-0.5 text-[11px] text-slate-500">{t('policy.wizard.intro')}</p>

      <div className="mt-3 space-y-3">
        {/* ① 项目类型 —— 只用来给下面三个问题一组建议答案 */}
        <div>
          <Label htmlFor="wizard-kind" className="text-xs text-slate-600">
            {t('policy.wizard.q.kind')}
          </Label>
          <Select value={kind} onValueChange={(v) => pickKind(v as ProjectKind)}>
            <SelectTrigger id="wizard-kind" className="mt-0.5 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {t(`policy.wizard.kind.${k}` as MessageKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-0.5 text-[11px] text-slate-400">{t('policy.wizard.kindHint')}</p>
        </div>

        <YesNo
          id="wizard-deploy"
          question={t('policy.wizard.q.deploy')}
          hint={t('policy.wizard.q.deployHint')}
          value={gateDeploy}
          onChange={setGateDeploy}
        />

        <YesNo
          id="wizard-db"
          question={t('policy.wizard.q.db')}
          hint={t('policy.wizard.q.dbHint')}
          value={gateDb}
          onChange={setGateDb}
        />

        <div>
          <Label htmlFor="wizard-budget" className="text-xs text-slate-600">
            {t('policy.wizard.q.budget')}
          </Label>
          <div className="mt-0.5 flex items-center gap-1">
            <Input
              id="wizard-budget"
              type="number"
              min={0}
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value))}
              className="w-28"
            />
            <span className="text-[11px] text-slate-400">{t('policy.wizard.q.budgetUnit')}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-slate-400">{t('policy.wizard.q.budgetHint')}</p>
        </div>
      </div>

      {/* ★ 会生成什么，当场列出来 —— 不藏在按钮后面 */}
      <div className="mt-3 rounded bg-slate-50 px-2 py-1.5">
        <p className="text-[11px] text-slate-500">
          {t('policy.wizard.willCreate', { count: planned.length })}
        </p>
        {planned.length === 0 ? (
          <p className="mt-0.5 text-xs text-amber-800">{t('policy.wizard.nothingSelected')}</p>
        ) : (
          <ul className="mt-0.5 space-y-0.5">
            {planned.map((rule) => (
              <li key={rule.key} className="text-xs leading-5 text-slate-700">
                · {t(rule.labelKey, { amount: budget })}
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="mt-2 rounded bg-red-50 px-2 py-1.5 text-xs text-red-800">{error}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="neutral"
          size="sm"
          onClick={() => generate.mutate()}
          disabled={
            generate.isPending || planned.length === 0 || !perms.can('policy.tighten')
          }
          title={perms.can('policy.tighten') ? undefined : perms.why('policy.tighten')}
        >
          {generate.isPending ? t('common.saving') : t('policy.wizard.generate')}
        </Button>
        {/*
          ★ 一定要给「我自己来」这条路。没有它，一个已经想好要配什么的人
            会被一份他不想要的建议挡在门口 —— 而那正是最该被放行的用户。
        */}
        <Button
          variant="ghost"
          onClick={onSkip}
          className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-[11px] text-slate-500 underline hover:text-slate-800"
        >
          {t('policy.wizard.skip')}
        </Button>
      </div>
    </section>
  );
}

function YesNo({
  id,
  question,
  hint,
  value,
  onChange,
}: {
  id: string;
  question: string;
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const t = useT();
  return (
    <div>
      <p id={id} className="text-xs text-slate-600">
        {question}
      </p>
      <div className="mt-0.5 flex items-center gap-1" role="radiogroup" aria-labelledby={id}>
        {[true, false].map((option) => (
          <Button
            key={String(option)}
            variant="ghost"
            role="radio"
            aria-checked={value === option}
            onClick={() => onChange(option)}
            className={
              value === option
                ? 'h-auto rounded border border-transparent bg-slate-900 px-2 py-0.5 text-[11px] font-normal text-white'
                : 'h-auto rounded border border-slate-300 px-2 py-0.5 text-[11px] font-normal text-slate-600 hover:bg-slate-50'
            }
          >
            {option ? t('policy.wizard.yes') : t('policy.wizard.no')}
          </Button>
        ))}
      </div>
      <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>
    </div>
  );
}
