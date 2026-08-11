import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import type { AutonomyLevel } from '@apos/contracts';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { CardSkeleton, ErrorState } from '../../components/states';
import { GatedButton, RoleBadge } from '../../components/Gated';
import { usePermissions } from '../../lib/permissions/usePermissions';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import type { PolicyRow, PolicyTemplateRow } from '../../lib/api/types';
import { RuleList } from './RuleList';
import { RuleEditor } from './RuleEditor';
import { ScenarioTester } from './ScenarioTester';
import { HitsPanel } from './HitsPanel';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

const AUTONOMY: { value: AutonomyLevel; label: string; desc: string }[] = [
  { value: 'human_led', label: 'Human-led', desc: '大部分操作默认需要人审批' },
  { value: 'agent_led_approval', label: 'Agent-led + Approval', desc: '中低风险自动，关键节点审批' },
  { value: 'agent_autonomous', label: 'Agent-autonomous', desc: '默认自动，仅异常时询问' },
];

const TABS = [
  { key: 'rules', label: '规则列表' },
  { key: 'test', label: '模拟测试' },
] as const;

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
  const { projectId } = useParams<{ projectId: string }>();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const perms = usePermissions(projectId);

  const tab = (TABS.find((t) => t.key === params.get('tab'))?.key ?? 'rules') as 'rules' | 'test';
  const [expandSummary, setExpandSummary] = useState(false);
  const [editing, setEditing] = useState<PolicyRow | null>(null);
  const [template, setTemplate] = useState<PolicyTemplateRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [toggling, setToggling] = useState<PolicyRow | null>(null);
  const [autonomyTarget, setAutonomyTarget] = useState<AutonomyLevel | null>(null);
  const [history, setHistory] = useState<PolicyRow | null>(null);
  const [hits, setHits] = useState<{ id: string; name: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<Set<string>>(new Set());

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
      setToast('规则已删除');
      void refresh();
    },
    onError: (e) => setToast(e instanceof ApiError ? e.message : '删除失败'),
  });

  if (!projectId) return null;
  const data = policies.data;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">
            {data?.project.name ?? '项目'} / 设置 / Policy
          </h1>
          <Link
            to={`/projects/${projectId}/board`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            ← 回到看板
          </Link>

          <RoleBadge projectId={projectId} />

          {/* ★ 自治等级是 Policy 的总开关，放在最显眼处 */}
          <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-600">
            自治等级
            <select
              value={data?.project.autonomyLevel ?? 'agent_led_approval'}
              onChange={(e) => setAutonomyTarget(e.target.value as AutonomyLevel)}
              // ★ 改自治等级是 pm / tech_lead 的事（§2.3）。
              //   禁用的同时把原因挂上去 —— 一个灰着又不说话的下拉框
              //   会让人以为页面卡住了。
              disabled={!perms.can('project.autonomy.change')}
              title={perms.why('project.autonomy.change')}
              className="rounded border border-slate-300 px-1.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="自治等级"
            >
              {AUTONOMY.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-1.5 flex items-center gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set('tab', t.key);
                setParams(next, { replace: true });
              }}
              className={clsx(
                'rounded px-2 py-0.5 text-xs',
                tab === t.key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100',
              )}
            >
              {t.label}
            </button>
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
            {/* ── 摘要：全页最重要的一行 ── */}
            <section className="rounded border border-slate-200 bg-white px-3 py-2">
              <p className="text-xs text-slate-700">
                ℹ 当前配置下：
                <span className="font-medium">{data.summary.auto.length}</span> 类操作自动执行，
                <span className="font-medium">{data.summary.human.length}</span> 类需要人类确认
                {data.summary.depends.length > 0 && (
                  <>
                    ，
                    <span className="font-medium">{data.summary.depends.length}</span> 类视情况而定
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setExpandSummary((v) => !v)}
                  className="ml-2 text-[11px] text-slate-500 underline hover:text-slate-800"
                >
                  {expandSummary ? '收起' : '查看完整清单'}
                </button>
              </p>
              <p className="mt-0.5 text-[11px] text-slate-400">
                继承自组织的规则 {data.orgPolicies.length} 条（不可删除，可收紧）· 项目自定义{' '}
                {data.projectPolicies.length} 条
              </p>

              {expandSummary && (
                <div className="mt-2 grid gap-3 border-t border-slate-100 pt-2 md:grid-cols-3">
                  <SummaryColumn title="自动执行" icon="✓" items={data.summary.auto.map((o) => o.label)} />
                  <SummaryColumn
                    title="需要人类确认"
                    icon="⚠"
                    items={data.summary.human.map((o) => `${o.label}${o.by ? ` → ${o.by}` : ''}`)}
                  />
                  {/*
                    ★ 「视情况」必须说清楚是什么情况。
                      只写「看情况」的摘要还不如不给 —— 用户仍然得自己去读规则。
                  */}
                  <SummaryColumn
                    title="视情况而定"
                    icon="~"
                    items={data.summary.depends.map((o) => `${o.label}：${o.when}`)}
                  />
                </div>
              )}
            </section>

            {/* ── 体检 ── */}
            {data.issues.length > 0 && (
              <section className="rounded border border-slate-200 bg-white px-3 py-2">
                <h2 className="text-xs font-medium text-slate-700">
                  ⚠ 检测到 {data.issues.length} 个问题
                </h2>
                <p className="text-[11px] text-slate-400">
                  基于常见场景的枚举检查。没报出来不等于没有问题 —— 这是抽样，不是证明
                </p>
                <ul className="mt-1 space-y-1">
                  {data.issues.map((issue, i) => {
                    const meta = SEVERITY[issue.severity];
                    return (
                      <li key={`${issue.type}-${i}`} className="flex items-start gap-2 text-xs">
                        <span aria-hidden>{meta.icon}</span>
                        <div className="min-w-0 flex-1">
                          <p className={meta.className}>{issue.message}</p>
                          {issue.example && (
                            <p className="text-[11px] text-slate-400">反例场景：{issue.example}</p>
                          )}
                          {issue.policyIds.length > 0 && (
                            <button
                              type="button"
                              onClick={() => setHighlight(new Set(issue.policyIds))}
                              className="text-[11px] text-slate-500 underline hover:text-slate-800"
                            >
                              定位到规则
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {tab === 'test' ? (
              <ScenarioTester projectId={projectId} />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-slate-500">从模板新建：</span>
                  {/*
                    ★ 模板自己就标了方向，正好对上 §2.3 的两档权限：
                      放宽类模板对 pm 是灰的，收紧类不是。这一排按钮
                      因此成了整套不对称设计最直观的一处展示 ——
                      用户不用读文档就能看出「收紧比放宽容易」。
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
                      {t.direction === 'loosen' ? '↓' : '↑'} {t.name}
                    </GatedButton>
                  ))}
                </div>

                <RuleList
                  title="项目自定义规则"
                  hint="完全可编辑，但不能放宽组织规则"
                  policies={data.projectPolicies}
                  highlightIds={highlight}
                  onEdit={(p) => {
                    setEditing(p);
                    setCreating(true);
                  }}
                  onToggle={setToggling}
                  onDelete={(p) => remove.mutate(p)}
                  onHistory={setHistory}
                  onViewHits={(p) => setHits({ id: p.id, name: p.name })}
                />

                <RuleList
                  title="继承自组织的规则"
                  hint="⛓ 项目内不可删除、不可放宽，只能收紧"
                  policies={data.orgPolicies}
                  highlightIds={highlight}
                  onEdit={() => setToast('组织级规则需要组织管理员修改')}
                  onToggle={() => setToast('组织级规则不能在项目内停用')}
                  onDelete={() => setToast('组织级规则不能在项目内删除')}
                  onHistory={setHistory}
                  onViewHits={(p) => setHits({ id: p.id, name: p.name })}
                />

                {/* ★ 如实说明哪些数据源没接 —— 依赖它们的规则永远不会命中 */}
                <p className="text-[11px] text-slate-400">
                  已接入的数据源：{data.wiredFacts.length > 0 ? data.wiredFacts.join('、') : '（无）'}。
                  CI 测试结果与安全扫描尚未接入，条件里用到它们的规则不会命中，体检区会单独标出
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
            setToast('规则已保存');
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
          <button type="button" className="ml-2 underline" onClick={() => setToast(null)}>
            知道了
          </button>
        </div>
      )}
    </div>
  );
}

function SummaryColumn({ title, icon, items }: { title: string; icon: string; items: string[] }) {
  return (
    <div>
      <p className="text-[11px] font-medium text-slate-600">
        {title}（{items.length}）
      </p>
      <ul className="mt-0.5 space-y-0.5">
        {items.length === 0 && <li className="text-[11px] text-slate-400">（无）</li>}
        {items.map((t) => (
          <li key={t} className="text-[11px] leading-4 text-slate-600">
            <span aria-hidden className="mr-1">
              {icon}
            </span>
            {t}
          </li>
        ))}
      </ul>
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
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () => api.togglePolicy(projectId, policy.id, !policy.enabled, reason),
    onSuccess: onDone,
    onError: (e) => setError(e instanceof ApiError ? e.message : '操作失败'),
  });

  return (
    <Modal onClose={onClose} title="启用/停用规则">
      <h2 className="text-sm font-semibold text-slate-900">
        {policy.enabled ? '停用' : '启用'}规则「{policy.name}」
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        {policy.enabled
          ? '停用等于放宽治理。原因会记入变更历史，之后没人需要猜「这条为什么被关掉了」'
          : '重新启用这条规则'}
      </p>

      <label className="mt-3 block text-xs text-slate-600">
        原因
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          className="mt-0.5"
          placeholder={policy.enabled ? '例如：发现回归未拦截，先关掉再补条件' : ''}
        />
      </label>

      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}

      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="text-xs text-slate-500">
          取消
        </button>
        <Button variant="neutral" size="sm"
          onClick={() => mut.mutate()}
          disabled={!reason.trim() || mut.isPending}>
          确认
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
    <Modal onClose={onClose} title="调整自治等级">
      <div className="w-[28rem] max-w-full">
        <h2 className="text-sm font-semibold text-slate-900">
          把自治等级从 {fromLabel} 改成 {toMeta?.label}
        </h2>
        <p className="mt-0.5 text-xs text-slate-500">{toMeta?.desc}</p>

        {preview.isPending && <p className="mt-3 text-xs text-slate-400">正在计算影响…</p>}

        {preview.data && (
          <div className="mt-3 space-y-2 text-xs">
            <p className="text-slate-700">
              自动执行的操作类型：{preview.data.autoBefore} → {preview.data.autoAfter}
            </p>
            {preview.data.becomesAuto.length > 0 && (
              <div className="rounded bg-green-50 px-2 py-1.5">
                <p className="text-[11px] font-medium text-green-900">
                  这些从此不再找你（{preview.data.becomesAuto.length}）
                </p>
                <p className="text-[11px] text-green-900">{preview.data.becomesAuto.join('、')}</p>
              </div>
            )}
            {preview.data.becomesGated.length > 0 && (
              <div className="rounded bg-amber-50 px-2 py-1.5">
                <p className="text-[11px] font-medium text-amber-900">
                  这些反过来会开始找你（{preview.data.becomesGated.length}）
                </p>
                <p className="text-[11px] text-amber-900">{preview.data.becomesGated.join('、')}</p>
              </div>
            )}
            {preview.data.becomesAuto.length === 0 && preview.data.becomesGated.length === 0 && (
              <p className="text-slate-500">
                当前规则已经覆盖了这些场景，切换自治等级不会改变任何操作的判定
              </p>
            )}
            <p className="text-[11px] text-slate-400">
              安全底线不受自治等级影响：删除资源、权限变更、执行付款永远需要人确认
            </p>
          </div>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="text-xs text-slate-500">
            取消
          </button>
          <Button variant="neutral" size="sm"
            onClick={() => apply.mutate()}
            disabled={apply.isPending}>
            确认切换
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** 变更历史（§5.11）—— Policy 变更是高敏感操作，必须完整审计 */
function HistoryDialog({ policy, onClose }: { policy: PolicyRow; onClose: () => void }) {
  const history = useQuery({
    queryKey: qk.policyHistory(policy.id),
    queryFn: () => api.policyHistory(policy.id),
  });

  return (
    <Modal onClose={onClose} title="策略详情">
      <div className="w-[28rem] max-w-full">
        <h2 className="text-sm font-semibold text-slate-900">「{policy.name}」的变更历史</h2>

        {history.isPending && <p className="mt-2 text-xs text-slate-400">加载中…</p>}
        {history.data?.history.length === 0 && (
          <p className="mt-2 text-xs text-slate-400">
            这条规则自创建以来没有被改动过（组织基线规则不经本页管理，没有变更记录）
          </p>
        )}

        <ul className="mt-2 space-y-1">
          {history.data?.history.map((h) => (
            <li key={h.version} className="border-b border-slate-100 py-1 text-xs last:border-0">
              <span className="text-slate-700">v{h.version}</span>
              <span className="ml-2 text-slate-500">{h.changedAt.slice(0, 16).replace('T', ' ')}</span>
              {h.direction && (
                <span
                  className={clsx(
                    'ml-2 text-[11px]',
                    h.direction === 'loosen' ? 'text-amber-700' : 'text-slate-500',
                  )}
                >
                  {h.direction === 'loosen' ? '放宽' : '收紧'}
                </span>
              )}
            </li>
          ))}
        </ul>

        <div className="mt-3 flex justify-end">
          <button type="button" onClick={onClose} className="text-xs text-slate-500">
            关闭
          </button>
        </div>
      </div>
    </Modal>
  );
}
