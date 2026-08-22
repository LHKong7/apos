import { hasMessage, t, useT, type MessageKey } from '../../lib/i18n';
import {
  joinList,
  policyEnvLabel,
  policyFactLabel,
  policyOperationLabel,
  riskName,
} from '@/lib/format';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import type { AutonomyLevel } from '@apos/contracts';
import { switchedOperationOf, type PolicyIssue } from '@apos/domain';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { CardSkeleton, ErrorState } from '../../components/states';
import { GatedButton, RoleBadge } from '../../components/Gated';
import { usePermissions } from '../../lib/permissions/usePermissions';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import type { PolicyRow, PolicyTemplateRow } from '../../lib/api/types';
import { RuleList } from './RuleList';
import { RuleEditor } from './RuleEditor';
import { OperationMatrix, type OperationRow } from './OperationMatrix';
import { OperationSwitchDialog } from './OperationSwitchDialog';
import { FirstRunWizard } from './FirstRunWizard';
import { ScenarioTester } from './ScenarioTester';
import { HitsPanel } from './HitsPanel';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { WhatIsThis } from '../Settings/primitives';

const AUTONOMY: { value: AutonomyLevel; label: string; descKey: MessageKey }[] = [
  { value: 'human_led', label: 'Human-led', descKey: 'policy.autonomy.assisted' },
  {
    value: 'agent_led_approval',
    label: 'Agent-led + Approval',
    descKey: 'policy.autonomy.supervised',
  },
  { value: 'agent_autonomous', label: 'Agent-autonomous', descKey: 'policy.autonomy.autonomous' },
];

const TABS = [
  { key: 'rules', labelKey: 'policy.tab.rules' },
  { key: 'test', labelKey: 'policy.tab.simulate' },
] as const satisfies readonly { key: string; labelKey: MessageKey }[];

/**
 * 体检结论的说法。
 *
 * ★ `missing_data_source` 那条要拼一个列表（「依赖 CI 测试结果、安全扫描」）——
 *   列表的连接词两种语言不同，所以必须在界面这一侧用 joinList 拼，
 *   而不是让服务端送一个拼好的字符串过来。
 */
function issueText(issue: PolicyIssue): string {
  const key = `policy.issue.${issue.type}` as MessageKey;
  if (!hasMessage(key)) return issue.message;
  const params: Record<string, string | number> = { ...(issue.params ?? {}) };
  if (issue.params?.['operation'] !== undefined) {
    params['operation'] = policyOperationLabel(String(issue.params['operation']));
  }
  if (issue.facts?.length) params['sources'] = joinList(issue.facts.map(policyFactLabel));
  return t(key, params);
}

/**
 * 反例场景：三段枚举各自取词后再拼，不用服务端那句中文。
 *
 * ★ 风险那一段用 `riskName`（「高」/ "High"）而不是 `riskLabel`
 *   （「高风险」/ "High risk"）—— `policy.scenario.risk` 这条词条
 *   自己已经带了「风险 / risk」，塞完整说法进去会得到
 *   「风险高风险」和 "High risk risk"。
 */
function exampleText(issue: PolicyIssue): string {
  const c = issue.exampleContext;
  if (!c) return issue.example ?? '';
  return [
    policyOperationLabel(c.operationType),
    t('policy.scenario.risk', { risk: riskName(c.riskLevel) }),
    c.environment ? policyEnvLabel(c.environment) : t('policy.env.none'),
  ].join(' · ');
}

const SEVERITY = {
  critical: { icon: '🔴', className: 'text-red-800' },
  warning: { icon: '🟡', className: 'text-amber-800' },
  info: { icon: '⚪', className: 'text-slate-600' },
} as const;

/**
 * Policy 配置（页面文档 13）。
 *
 * ★ 这一页的核心难题：Policy 本质是规则引擎，很容易做成只有工程师
 *   看得懂的配置界面。但真正需要设定边界的是项目负责人和业务负责人。
 *   所以整页围绕三件事组织：**模板**（不用懂语法就能配）、
 *   **人话解释**（配完看得懂自己配了什么）、**模拟**（敢按下启用）。
 *
 * ★ 顶部那句「N 类操作自动执行，M 类需要人类确认」是全页最重要的一行。
 *   用户不会去读 12 条规则再自己推导边界 —— 他要的就是这一句。
 */
export function PoliciesPage() {
  const t = useT();
  const { projectId } = useParams<{ projectId: string }>();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const perms = usePermissions(projectId);

  const tab = (TABS.find((t) => t.key === params.get('tab'))?.key ?? 'rules') as 'rules' | 'test';
  /**
   * ★★ 默认**展开**结果摘要。
   *
   *   这一页的第一屏该回答「Agent 现在能自己干什么、什么会停下来等我」，
   *   而不是「规则怎么写」。收起来的时候，用户看到的第一屏是一张条件表达式
   *   列表 —— 而那个答案在表达式里是**推**出来的：要同时考虑规则优先级、
   *   自治等级和默认动作。让每个人自己在脑子里跑一遍求值器，出错是必然的，
   *   而出错的方向是「以为拦着，其实没拦」。
   *
   *   摘要本身早就算好了（domain 的 auditPolicies），只是默认藏着。
   *
   *   The outcome summary is expanded by default: the first screen should answer
   *   "what can an Agent do on its own", not "how is the rule written". Deriving
   *   the former from a list of expressions requires mentally running the
   *   evaluator, and that derivation errs toward "I thought that was gated".
   */
  const [expandSummary, setExpandSummary] = useState(true);
  const [editing, setEditing] = useState<PolicyRow | null>(null);
  const [template, setTemplate] = useState<PolicyTemplateRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [toggling, setToggling] = useState<PolicyRow | null>(null);
  const [autonomyTarget, setAutonomyTarget] = useState<AutonomyLevel | null>(null);
  const [history, setHistory] = useState<PolicyRow | null>(null);
  const [hits, setHits] = useState<{ id: string; name: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /** ★ 体检默认收起 —— 第一屏是摘要与开关，不是一张问题清单 */
  const [expandIssues, setExpandIssues] = useState(false);
  const [switching, setSwitching] = useState<{
    operationType: string;
    verdict: 'auto' | 'human';
  } | null>(null);
  /**
   * 用户在引导向导上点了「我自己来」。
   *
   * ★ 只记在内存里，不落 localStorage：这一页刷新一次就该重新给出建议 ——
   *   一个跳过过一次就再也不出现的引导，等于把「这个项目还没设边界」
   *   这件事永久藏了起来。
   */
  const [wizardSkipped, setWizardSkipped] = useState(false);

  const policies = useQuery({
    queryKey: qk.policies(projectId!),
    queryFn: () => api.policies(projectId!),
    enabled: Boolean(projectId),
  });

  const templates = useQuery({
    queryKey: qk.policyTemplates(),
    queryFn: () => api.policyTemplates(),
    staleTime: Infinity,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: qk.policies(projectId!) });

  const remove = useMutation({
    mutationFn: (p: PolicyRow) => api.deletePolicy(projectId!, p.id),
    onSuccess: () => {
      setToast(t('policy.deleted'));
      void refresh();
    },
    onError: (e) => setToast(e instanceof ApiError ? e.message : t('policy.deleteFailed')),
  });

  /** 关掉一行的开关 = 删掉它建的那条规则，不用弹窗确认：它本来就是「还原」 */
  const clearing = useMutation({
    mutationFn: (operationType: string) => api.clearOperationSwitch(projectId!, operationType),
    onSuccess: () => {
      setToast(t('policy.switch.cleared'));
      void refresh();
    },
    onError: (e) => setToast(e instanceof ApiError ? e.message : t('policy.actionFailed')),
  });

  if (!projectId) return null;
  const data = policies.data;

  /**
   * 体检结论分两堆：指向某条规则的贴到那条规则上，剩下的单独列。
   *
   * ★ 判据是「有没有一条画得出来的规则可指」。列表只画项目规则 ——
   *   指向别处的 id 既贴不上去，也没有可跳转的目标，只能留在下面那一堆里。
   */
  const projectRuleIds = new Set(data?.projectPolicies.map((p) => p.id) ?? []);
  const attachable = (issue: PolicyIssue) => issue.policyIds.filter((id) => projectRuleIds.has(id));
  const globalIssues = (data?.issues ?? []).filter((i) => attachable(i).length === 0);
  const issuesOf = (p: PolicyRow) =>
    (data?.issues ?? [])
      .filter((i) => attachable(i).includes(p.id))
      .map((i) => ({
        severity: i.severity,
        text: issueText(i),
        example: i.exampleContext || i.example ? exampleText(i) : null,
      }));

  /**
   * 开关矩阵的行。
   *
   * ★ 顺序按操作类型的**枚举**排，不按当前判定分组。
   *   按判定分组的话，翻一个开关会让那一行跳到别的位置去 ——
   *   用户下一秒想改回来，得先重新找到它。开关面板的行必须是稳定的。
   */
  const matrixRows: OperationRow[] = data
    ? [...data.summary.auto, ...data.summary.human, ...data.summary.depends]
        .sort((a, b) => a.operationType.localeCompare(b.operationType))
        .map((outcome) => ({
          outcome,
          switchRule:
            data.projectPolicies.find(
              (p) => switchedOperationOf(p.condition) === outcome.operationType,
            ) ?? null,
        }))
    : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">
            {t('policy.breadcrumb', { project: data?.project.name ?? t('policy.scope.project') })}
          </h1>
          <Link
            to={`/projects/${projectId}/board`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            {t('nav.backToBoard')}
          </Link>

          <RoleBadge projectId={projectId} />

          {/* ★ 自治等级是 Policy 的总开关，放在最显眼处 */}
          {/*
            ★ 从「label 包着 select」改成 htmlFor 关联：Radix 的触发器是
              <Button variant="ghost" className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent">，包起来点标签文字打不开下拉。
          */}
          <div className="ml-auto flex items-center gap-1.5 text-xs text-slate-600">
            <Label htmlFor="autonomy-level" className="font-normal text-slate-600">
              {t('policy.autonomyLevel')}
            </Label>
            <Select
              value={data?.project.autonomyLevel ?? 'agent_led_approval'}
              onValueChange={(v) => setAutonomyTarget(v as AutonomyLevel)}
              // ★ 改自治等级是 pm / tech_lead 的事（§2.3）。
              //   禁用的同时把原因挂上去 —— 一个灰着又不说话的下拉框
              //   会让人以为页面卡住了。
              disabled={!perms.can('project.autonomy.change')}
            >
              <SelectTrigger
                id="autonomy-level"
                className="w-auto disabled:cursor-not-allowed disabled:opacity-50"
                title={perms.why('project.autonomy.change')}
                aria-label={t('policy.autonomyLevel')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTONOMY.map((a) => (
                  <SelectItem key={a.value} value={a.value}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-1.5 flex items-center gap-1">
          {/* ★ 参数别叫 t —— 会遮住 i18n 的 t，而报错只说「不可调用」 */}
          {TABS.map((item) => (
            <Button variant="ghost"
              key={item.key}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set('tab', item.key);
                setParams(next, { replace: true });
              }}
              className={clsx('h-auto p-0 font-normal whitespace-normal hover:bg-transparent', 
                'rounded px-2 py-0.5 text-xs',
                tab === item.key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100',
              )}
            >
              {t(item.labelKey)}
            </Button>
          ))}
        </div>
      </div>

      {policies.isError && (
        <div className="p-4">
          <ErrorState error={policies.error} onRetry={() => void policies.refetch()} />
        </div>
      )}
      {policies.isPending && (
        <div className="space-y-2 p-4">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      )}

      {data && (
        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-3">
          <div className="mx-auto max-w-4xl space-y-3">
            {/*
              ★ 这一页说的是领域词汇（Policy / 角色 / 集成 / 成员与授权），
                对写它的人是精确的，对项目经理是一堵墙。头一句先回答
                「这跟我有关系吗」（问题记录 #42）。
            */}
            <WhatIsThis storageKey="policies" title={t('whatIs.policies.title')}>
              <p>{t('whatIs.policies.p1')}</p>
              <p>{t('whatIs.policies.p2')}</p>
              <p>{t('whatIs.policies.p3')}</p>
            </WhatIsThis>
            {/* ── 摘要：全页最重要的一行 ── */}
            <section className="rounded border border-slate-200 bg-white px-3 py-2">
              <p className="text-xs text-slate-700">
                {t('policy.currentConfig')}
                <span className="font-medium">{data.summary.auto.length}</span> {t('policy.summaryAuto')}
                <span className="font-medium">{data.summary.human.length}</span> {t('policy.summaryHuman')}
                {data.summary.depends.length > 0 && (
                  <>
                    ，
                    <span className="font-medium">{data.summary.depends.length}</span> {t('policy.summaryDepends')}
                  </>
                )}
                <Button variant="ghost"
                  onClick={() => setExpandSummary((v) => !v)}
                  className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent ml-2 text-[11px] text-slate-500 underline hover:text-slate-800"
                >
                  {expandSummary ? t('policy.collapse') : t('policy.showFullList')}
                </Button>
              </p>
              {expandSummary && (
                <OperationMatrix
                  rows={matrixRows}
                  projectId={projectId}
                  busyOperation={clearing.isPending ? clearing.variables : null}
                  onSet={(operationType, verdict) => setSwitching({ operationType, verdict })}
                  onClear={(operationType) => clearing.mutate(operationType)}
                />
              )}
            </section>

            {/*
              ── 体检：只剩「不指向任何一条规则」的那几条，且默认收起 ──

              ★★ 指向某条规则的结论已经贴到那条规则自己身上了（见 RuleList）。
                留在这里的是「高风险操作没人管」这类**没有规则可指**的发现 ——
                它们没有可跳转的目标，只能单独列。
              ★ 默认收起：第一屏该回答「Agent 现在能干什么」，
                不是先摆一张问题清单。
            */}
            {globalIssues.length > 0 && (
              <section className="rounded border border-slate-200 bg-white px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xs font-medium text-slate-700">
                    {t('policy.issuesFound', { count: globalIssues.length })}
                  </h2>
                  <Button
                    variant="ghost"
                    onClick={() => setExpandIssues((v) => !v)}
                    className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-[11px] text-slate-500 underline hover:text-slate-800"
                  >
                    {expandIssues ? t('policy.collapse') : t('policy.showFullList')}
                  </Button>
                </div>

                {expandIssues && (
                  <>
                    <p className="text-[11px] text-slate-400">{t('policy.issuesHint')}</p>
                    <ul className="mt-1 space-y-1">
                      {globalIssues.map((issue, i) => {
                        const meta = SEVERITY[issue.severity];
                        return (
                          <li key={`${issue.type}-${i}`} className="flex items-start gap-2 text-xs">
                            <span aria-hidden>{meta.icon}</span>
                            <div className="min-w-0 flex-1">
                              {/*
                                ★ 按 `type` 取词。服务端那句 `message` 是中文，
                                  只作认不出 type 时的兜底。规则名走 params 原样带过来 ——
                                  用户起的名不翻译。
                              */}
                              <p className={meta.className}>{issueText(issue)}</p>
                              {(issue.exampleContext || issue.example) && (
                                <p className="text-[11px] text-slate-400">
                                  {t('policy.counterExample', { example: exampleText(issue) })}
                                </p>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </section>
            )}

            {tab === 'test' ? (
              <ScenarioTester projectId={projectId} />
            ) : data.projectPolicies.length === 0 && !wizardSkipped ? (
              /*
                ★★ 一条规则都没有时，列表区不是「空列表 + 一排模板按钮」。
                  那两样东西一起说的是「这里本该有东西，你自己去配」——
                  而用户此刻既不知道该配什么，也不知道配多少算够，
                  最常见的结局是关掉页面，项目就这么零规则跑下去。
              */
              <FirstRunWizard
                projectId={projectId}
                onSkip={() => setWizardSkipped(true)}
                onDone={(message) => {
                  setToast(message);
                  void refresh();
                }}
              />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-slate-500">{t('policy.fromTemplate')}</span>
                  {/*
                    ★★ 「收紧 / 放宽」这两个词不再出现在按钮上。
                      它们是治理模型的内部词汇：用户要判断一个 ↑ 还是 ↓
                      对自己意味着什么，得先知道这套模型分了两档权限。
                      而这件事**不需要**他知道 —— 他真正会撞上的只有一种情形：
                      某个按钮是灰的。那时权限差异会以「你为什么点不了、该找谁」
                      的形式出现，那句话服务端已经算好了。
                      灰按钮 + 原因说得清的事，不必先教一套术语。
                  */}
                  {templates.data?.templates.map((t) => (
                    <GatedButton
                      key={t.id}
                      permission={t.direction === 'loosen' ? 'policy.loosen' : 'policy.tighten'}
                      projectId={projectId}
                      onClick={() => {
                        setTemplate(t);
                        setCreating(true);
                      }}
                      className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50"
                    >
                      {t.name}
                    </GatedButton>
                  ))}
                </div>

                <RuleList
                  title={t('policy.projectRules')}
                  hint={t('policy.projectRulesHint')}
                  policies={data.projectPolicies}
                  issuesOf={issuesOf}
                  onEdit={(p) => {
                    setEditing(p);
                    setCreating(true);
                  }}
                  onToggle={setToggling}
                  onDelete={(p) => remove.mutate(p)}
                  onHistory={setHistory}
                  onViewHits={(p) => setHits({ id: p.id, name: p.name })}
                />

                {/* ★ 如实说明哪些数据源没接 —— 依赖它们的规则永远不会命中 */}
                <p className="text-[11px] text-slate-400">
                  {t('policy.wiredFacts', {
                    facts:
                      data.wiredFacts.length > 0
                        ? joinList(data.wiredFacts)
                        : t('policy.none'),
                  })}
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {creating && (
        <RuleEditor
          projectId={projectId}
          template={editing ? null : template}
          editing={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
            setTemplate(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            setTemplate(null);
            setToast(t('policy.saved'));
            void refresh();
          }}
        />
      )}

      {switching && (
        <OperationSwitchDialog
          projectId={projectId}
          operationType={switching.operationType}
          verdict={switching.verdict}
          onClose={() => {
            setSwitching(null);
            void refresh();
          }}
          onDone={(message) => {
            setSwitching(null);
            setToast(message);
            void refresh();
          }}
        />
      )}

      {toggling && (
        <ToggleDialog
          policy={toggling}
          projectId={projectId}
          onClose={() => setToggling(null)}
          onDone={() => {
            setToggling(null);
            void refresh();
          }}
        />
      )}

      {autonomyTarget && (
        <AutonomyDialog
          projectId={projectId}
          from={data?.project.autonomyLevel as AutonomyLevel}
          to={autonomyTarget}
          onClose={() => setAutonomyTarget(null)}
          onDone={() => {
            setAutonomyTarget(null);
            void refresh();
          }}
        />
      )}

      {history && <HistoryDialog policy={history} onClose={() => setHistory(null)} />}
      {hits && projectId && (
        <HitsPanel
          projectId={projectId}
          policyId={hits.id}
          policyName={hits.name}
          onClose={() => setHits(null)}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 z-50 max-w-lg -translate-x-1/2 rounded bg-slate-900 px-3 py-2 text-xs text-white shadow-lg">
          {toast}
          <Button variant="ghost" className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent ml-2 underline" onClick={() => setToast(null)}>
            {t('common.gotIt')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** 停用规则必须填原因 —— 规则的变更历史本身就是组织知识（§5.3） */
function ToggleDialog({
  policy,
  projectId,
  onClose,
  onDone,
}: {
  policy: PolicyRow;
  projectId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () => api.togglePolicy(projectId, policy.id, !policy.enabled, reason),
    onSuccess: onDone,
    onError: (e) => setError(e instanceof ApiError ? e.message : t('policy.actionFailed')),
  });

  return (
    <Modal onClose={onClose} title={t('policy.toggleRule')}>
      <h2 className="text-sm font-semibold text-slate-900">
        {t('policy.toggleNamed', { action: policy.enabled ? t('policy.disable') : t('policy.enable'), name: policy.name })}
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        {policy.enabled
          ? t('policy.disableHint')
          : t('policy.enableHint')}
      </p>

      <Label className="mt-3 block text-xs text-slate-600">
        {t('policy.reason')}
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          className="mt-0.5"
          placeholder={policy.enabled ? t('policy.disableReasonPlaceholder') : ''}
        />
      </Label>

      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}

      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-xs text-slate-500">
          {t('common.cancel')}
        </Button>
        <Button variant="neutral" size="sm"
          onClick={() => mut.mutate()}
          disabled={!reason.trim() || mut.isPending}>
          {t('common.confirm')}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * 切换自治等级前先看影响（§5.9）。
 *
 * ★ 「切过去会更自动化一些」是句废话。用户要的是具体清单：
 *   哪几类操作从此不再找我，哪几类反过来要开始找我。
 */
function AutonomyDialog({
  projectId,
  from,
  to,
  onClose,
  onDone,
}: {
  projectId: string;
  from: AutonomyLevel;
  to: AutonomyLevel;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const preview = useQuery({
    queryKey: ['autonomyPreview', projectId, to],
    queryFn: () => api.autonomyPreview(projectId, to),
  });

  const apply = useMutation({
    mutationFn: () => api.setAutonomy(projectId, to),
    onSuccess: onDone,
  });

  const fromLabel = AUTONOMY.find((a) => a.value === from)?.label ?? from;
  const toMeta = AUTONOMY.find((a) => a.value === to);

  return (
    <Modal onClose={onClose} title={t('policy.adjustAutonomy')}>
      <div className="w-[28rem] max-w-full">
        <h2 className="text-sm font-semibold text-slate-900">
          {t('policy.autonomyChange', { from: fromLabel, to: toMeta?.label ?? '' })}
        </h2>
        <p className="mt-0.5 text-xs text-slate-500">
          {toMeta ? t(toMeta.descKey) : ''}
        </p>

        {preview.isPending && <p className="mt-3 text-xs text-slate-400">{t('policy.computingImpact')}</p>}

        {preview.data && (
          <div className="mt-3 space-y-2 text-xs">
            <p className="text-slate-700">
              {t('policy.autoTypesChange', {
                before: preview.data.autoBefore,
                after: preview.data.autoAfter,
              })}
            </p>
            {preview.data.becomesAuto.length > 0 && (
              <div className="rounded bg-green-50 px-2 py-1.5">
                <p className="text-[11px] font-medium text-green-900">
                  {t('policy.becomesAuto', { count: preview.data.becomesAuto.length })}
                </p>
                <p className="text-[11px] text-green-900">{joinList(preview.data.becomesAuto)}</p>
              </div>
            )}
            {preview.data.becomesGated.length > 0 && (
              <div className="rounded bg-amber-50 px-2 py-1.5">
                <p className="text-[11px] font-medium text-amber-900">
                  {t('policy.becomesGated', { count: preview.data.becomesGated.length })}
                </p>
                <p className="text-[11px] text-amber-900">{joinList(preview.data.becomesGated)}</p>
              </div>
            )}
            {preview.data.becomesAuto.length === 0 && preview.data.becomesGated.length === 0 && (
              <p className="text-slate-500">
                {t('policy.noChange')}
              </p>
            )}
            <p className="text-[11px] text-slate-400">
              {t('policy.safetyFloor')}
            </p>
          </div>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-xs text-slate-500">
            {t('common.cancel')}
          </Button>
          <Button variant="neutral" size="sm"
            onClick={() => apply.mutate()}
            disabled={apply.isPending}>
            {t('policy.confirmSwitch')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** 变更历史（§5.11）—— Policy 变更是高敏感操作，必须完整审计 */
function HistoryDialog({ policy, onClose }: { policy: PolicyRow; onClose: () => void }) {
  const t = useT();
  const history = useQuery({
    queryKey: qk.policyHistory(policy.id),
    queryFn: () => api.policyHistory(policy.id),
  });

  return (
    <Modal onClose={onClose} title={t('policy.detail')}>
      <div className="w-[28rem] max-w-full">
        <h2 className="text-sm font-semibold text-slate-900">{t('policy.historyOf', { name: policy.name })}</h2>

        {history.isPending && <p className="mt-2 text-xs text-slate-400">{t('common.loading')}</p>}
        {history.data?.history.length === 0 && (
          <p className="mt-2 text-xs text-slate-400">
            {t('policy.noHistory')}
          </p>
        )}

        <ul className="mt-2 space-y-1">
          {history.data?.history.map((h) => (
            <li key={h.version} className="border-b border-slate-100 py-1 text-xs last:border-0">
              <span className="text-slate-700">v{h.version}</span>
              <span className="ml-2 text-slate-500">{h.changedAt.slice(0, 16).replace('T', ' ')}</span>
              {/*
                ★ 说结果，不说术语。「放宽 / 收紧」是治理模型的内部词汇，
                  而变更历史要回答的是「这一次改动之后，人少批了还是多批了」——
                  后者不用先学一套词汇就读得懂，信息量还一点没少。
              */}
              {h.direction && (
                <span
                  className={clsx(
                    'ml-2 text-[11px]',
                    h.direction === 'loosen' ? 'text-amber-700' : 'text-slate-500',
                  )}
                >
                  {h.direction === 'loosen'
                    ? t('policy.history.fewerChecks')
                    : t('policy.history.moreChecks')}
                </span>
              )}
            </li>
          ))}
        </ul>

        <div className="mt-3 flex justify-end">
          <Button variant="ghost" onClick={onClose} className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-xs text-slate-500">
            {t('common.close')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
