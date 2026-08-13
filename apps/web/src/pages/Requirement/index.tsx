import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { CardSkeleton, ErrorState } from '../../components/states';
import { GatedButton } from '../../components/Gated';
import { useT, type MessageKey } from '../../lib/i18n';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import { Completeness } from './Completeness';
import { AnalysisRuns } from './AnalysisRuns';
import { Clarifications } from './Clarifications';
import { StructuredEditor, type RequirementPatch } from './StructuredEditor';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

/**
 * 需求录入、AI 澄清与人工填写（页面文档 03）。
 *
 * ★ 这是整个产品的第一个 Human Gate，也是决定后续所有自动化质量的地方。
 *   宁可在这里多花两分钟，也不要让 Agent 基于错误理解跑三小时。
 *
 * ★ 原始输入永远保留在左边，与结构化结果左右对照。
 *   用户必须能验证 AI 没有曲解自己的意思 —— 这是建立信任的地基，
 *   一旦原文被结构化结果覆盖掉，用户就再也没法自己核对了。
 *
 * ★★ 结构化结果有**两个来源，地位相同**：AI 分析、人工填写。
 *
 *   此前只有 AI 一条路，而且是硬闸门：没分析过就没有标题，没有标题
 *   确认按钮就不出现。于是需求写得再清楚也得先让 Agent 跑一遍；
 *   没配规划 Agent 或分析超时（产品文档 03 §7 给的出路正是「转人工填写」）
 *   时，这一页干脆走不下去。
 *
 *   现在两条路可以互相接力：AI 出稿→人改、人写→AI 补充分析，都成立。
 *   每个字段标出它现在是谁写的（fieldProvenance），因为「这句话是我写的
 *   还是 AI 写的」正是确认时最该看清的一件事。
 */
export function RequirementPage() {
  const { projectId, reqId } = useParams<{ projectId: string; reqId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const t = useT();
  /**
   * ★ 列表页选了「自己填写」就带着 ?edit=1 进来，直接落在编辑态。
   *   否则用户刚表达完「我要自己填」，看到的还是一个「让 AI 分析」的空面板 ——
   *   他的选择在跳转的一瞬间就丢了。
   */
  const [params] = useSearchParams();

  const [answering, setAnswering] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(params.get('edit') === '1');
  /** 上一轮重新分析保住了哪些人工字段 */
  const [keptFields, setKeptFields] = useState<string[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: qk.requirement(reqId!),
    queryFn: () => api.requirement(reqId!),
    enabled: Boolean(reqId),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: qk.requirement(reqId!) });

  /**
   * ★ 重新分析**不覆盖**人改过的字段（服务端按 fieldProvenance 判定）。
   *   保住了哪几个必须说出来：不说的话，用户会以为「分析怎么没改这几项」，
   *   而真相恰恰相反 —— 是平台在替他护着自己写的那几句。
   */
  const analyze = useMutation({
    mutationFn: () => api.analyzeRequirement(reqId!),
    onSuccess: (res) => {
      setKeptFields(res.keptHumanFields ?? []);
      void refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('requirement.detail.analyzeFailed')),
  });

  /**
   * 人工填写 / 修改结构化字段。
   *
   * ★ 保存后要重新拉一次：服务端会据此重算完整度并推进状态，
   *   而完整度正是用户判断「够不够格确认」的依据 ——
   *   不刷新的话，他改完看到的还是改之前那个分数。
   */
  const edit = useMutation({
    mutationFn: (patch: RequirementPatch) => api.editRequirement(reqId!, patch),
    onSuccess: () => {
      setEditing(false);
      setEditError(null);
      void refresh();
    },
    onError: (e) => setEditError(e instanceof ApiError ? e.message : t('requirement.detail.saveFailed')),
  });

  const answer = useMutation({
    mutationFn: (v: { id: string; answer: string; usedSuggestion: boolean }) =>
      api.answerClarification(v.id, { answer: v.answer, usedSuggestion: v.usedSuggestion }),
    onMutate: (v) => setAnswering(v.id),
    onSettled: () => setAnswering(null),
    onSuccess: () => void refresh(),
    onError: (e) => setError(e instanceof ApiError ? e.message : t('requirement.detail.answerFailed')),
  });

  /**
   * 确认 → 生成计划 → 直接进计划页。
   *
   * 中间不停留：用户刚做完一个判断，此刻最该看到的是这个判断导致了什么，
   * 而不是回到一个列表再自己找。
   */
  const approve = useMutation({
    /**
     * ★★ 一次调用，不再是前端连发两个请求。
     *
     *   以前中间断掉留下的是「需求已确认但没有计划」——
     *   状态变了，而界面上是一句报错。
     */
    mutationFn: () => api.approveAndPlan(reqId!),
    onSuccess: (result) => {
      if (result.plan) {
        navigate(`/projects/${projectId}/plans/${result.plan.planId}`);
        return;
      }
      /**
       * ★ 确认成功、生成失败：如实说出来，并留在需求页 ——
       *   跳去一个不存在的计划页是最坏的处理。重试的是「生成计划」，
       *   不是「再确认一次」。
       */
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: qk.requirement(reqId!) });
      setError(t('requirement.detail.approvedButPlanFailed', { reason: result.planError ?? '' }));
    },
    onError: (e) => {
      setConfirming(false);
      if (e instanceof ApiError && e.code === 'UNANSWERED_MUST_CONFIRM') {
        setError(t('requirement.detail.mustAnswerFirst', { message: e.message }));
        return;
      }
      setError(e instanceof ApiError ? e.message : t('requirement.detail.approveFailed'));
    },
  });

  const reject = useMutation({
    mutationFn: (reason: string) => api.rejectRequirement(reqId!, reason),
    onSuccess: () => {
      setRejecting(false);
      void refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('requirement.detail.rejectFailed')),
  });

  /**
   * 删除。成功后回需求列表 —— 详情页的主体已经不存在了，留在原地
   * 只会是一屏各自 404 的组件。
   *
   * ★ 服务端挡下时（已派生出计划或工作项）报错里写了挡在哪，
   *   原样显示即可，不要换成一句「删除失败」。
   */
  const remove = useMutation({
    mutationFn: () => api.deleteRequirement(reqId!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.requirements(projectId!) });
      navigate(`/projects/${projectId}/requirements`);
    },
    onError: (e) => {
      setDeleting(false);
      setError(e instanceof ApiError ? e.message : t('requirement.delete.failed'));
    },
  });

  if (!projectId || !reqId) return null;
  if (detail.isPending) return <div className="p-4"><CardSkeleton /></div>;
  if (detail.isError) {
    return (
      <div className="p-4">
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { requirement: r, clarifications } = detail.data!;
  /**
   * ★★ 闸门看**有没有内容**，不看**是不是 AI 分析出来的**。
   *   按后者设闸门，等于把人工填写这条路堵死在最后一步：
   *   一份人写得清清楚楚的需求，会因为「没跑过分析」而没有确认按钮。
   */
  const structured = Boolean(
    r.title?.trim() || r.businessGoal?.trim() || r.acceptanceCriteria.length > 0,
  );
  const analyzed = r.analysisModel !== null;
  const readOnly = r.status === 'approved' || r.status === 'rejected';
  const mustConfirm = clarifications.filter((c) => c.level === 'must_confirm' && !c.answer);
  const assumptions = clarifications.filter((c) => c.level === 'assumption_ok');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">
            {r.title ?? t('requirement.detail.untitled')}
          </h1>
          <span
            className={clsx(
              'rounded px-1.5 py-0.5 text-[11px]',
              r.status === 'approved'
                ? 'bg-green-100 text-green-800'
                : r.status === 'rejected'
                  ? 'bg-red-100 text-red-800'
                  : 'bg-slate-100 text-slate-600',
            )}
          >
            {STATUS_KEYS[r.status] ? t(STATUS_KEYS[r.status]!) : r.status}
          </span>
          <Link
            to={`/projects/${projectId}/requirements`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            {t('requirement.detail.backToList')}
          </Link>
        </div>

        {/* ★ 人工填的需求同样有完整度 —— 它评的是内容，不是「跑没跑过分析」 */}
        {structured && <div className="mt-1.5"><Completeness scores={r.completeness} /></div>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-3">
        <div className="mx-auto max-w-5xl space-y-3">
          {error && (
            <p className="rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800">
              {error}
              <button type="button" className="ml-2 underline" onClick={() => setError(null)}>
                {t('common.gotIt')}
              </button>
            </p>
          )}

          {r.status === 'rejected' && r.rejectReason && (
            <p className="rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800">
              {t('requirement.detail.rejectedWith', { reason: r.rejectReason })}
            </p>
          )}

          {/*
            ★ 历次分析 / 规划执行。规划 Run 落库之后这一块才有内容 ——
              在此之前那些调用只活在内存里，事后什么都查不到。
          */}
          <AnalysisRuns requirementId={reqId!} />

          <div className="grid gap-3 md:grid-cols-2">
            {/* ── 原始输入：永不覆盖 ── */}
            <section className="rounded border border-slate-200 bg-white px-3 py-2">
              <h2 className="text-xs font-medium text-slate-700">{t('requirement.detail.rawInput')}</h2>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-6 text-slate-700">
                {r.rawInput}
              </p>
              <p className="mt-2 border-t border-slate-100 pt-1.5 text-[11px] text-slate-400">
                {t('requirement.detail.rawInputNote')}
              </p>
            </section>

            {/* ── 结构化需求：AI 分析与人工填写共用这一块 ── */}
            <section className="rounded border border-slate-200 bg-white px-3 py-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="text-xs font-medium text-slate-700">
                  {t('requirement.detail.structured')}
                </h2>
                {analyzed && <AnalysisSource model={r.analysisModel} />}
                {!editing && !readOnly && (
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => analyze.mutate()}
                      disabled={analyze.isPending}
                      className="text-[11px] text-slate-500 underline disabled:opacity-50"
                    >
                      {analyze.isPending
                        ? t('requirement.detail.analyzing')
                        : analyzed
                          ? t('requirement.detail.reanalyze')
                          : t('requirement.detail.analyze')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditError(null);
                        setEditing(true);
                      }}
                      className="text-[11px] text-slate-500 underline hover:text-slate-700"
                    >
                      {structured ? t('requirement.detail.editManually') : t('requirement.detail.fillManually')}
                    </button>
                  </div>
                )}
              </div>

              {keptFields.length > 0 && !editing && (
                <p className="mt-1 rounded bg-sky-50 px-2 py-1 text-[11px] text-sky-800">
                  {t('requirement.detail.keptFields', {
                    fields: keptFields.map((f) => (FIELD_KEYS[f] ? t(FIELD_KEYS[f]!) : f)).join('、'),
                  })}
                  <button
                    type="button"
                    className="ml-1 underline"
                    onClick={() => setKeptFields([])}
                  >
                    {t('common.gotIt')}
                  </button>
                </p>
              )}

              {editing ? (
                <StructuredEditor
                  requirement={r}
                  saving={edit.isPending}
                  error={editError}
                  onSave={(patch) => edit.mutate(patch)}
                  onCancel={() => {
                    setEditing(false);
                    setEditError(null);
                  }}
                />
              ) : !structured ? (
                /*
                  ★ 两个入口并排给，措辞上不分主次。
                    把「自己填写」做成小字兜底，人只会在 AI 失败之后才发现它 ——
                    而那时他已经等过一轮超时了。
                */
                <div className="py-6 text-center">
                  <p className="text-xs text-slate-500">{t('requirement.detail.notStructured')}</p>
                  <div className="mt-2 flex justify-center gap-2">
                    <Button
                      variant="neutral"
                      size="sm"
                      onClick={() => analyze.mutate()}
                      disabled={analyze.isPending || readOnly}
                    >
                      {analyze.isPending
                        ? t('requirement.detail.analyzing')
                        : t('requirement.detail.letAiAnalyze')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditing(true)}
                      disabled={readOnly}
                    >
                      {t('requirement.detail.fillManually')}
                    </Button>
                  </div>
                  <p className="mt-2 text-[11px] text-slate-400">
                    {t('requirement.detail.bothPathsNote')}
                  </p>
                </div>
              ) : (
                <dl className="mt-1 space-y-1.5 text-xs">
                  <Field label={t('requirement.field.businessContext')} value={r.businessContext} source={sourceOf(r, 'businessContext')} />
                  <Field label={t('requirement.field.userProblem')} value={r.userProblem} source={sourceOf(r, 'userProblem')} />
                  <Field label={t('requirement.field.businessGoal')} value={r.businessGoal} source={sourceOf(r, 'businessGoal')} />
                  <div>
                    <dt className="text-[11px] text-slate-500">
                      {t('requirement.field.scope')}
                      <SourceTag source={sourceOf(r, 'scope')} />
                      {(r.scope.inScope?.length ?? 0) === 0 && (
                        <span className="ml-1 text-amber-700">{t('requirement.detail.unrecognized')}</span>
                      )}
                    </dt>
                    <dd className="text-slate-700">
                      {(r.scope.inScope ?? []).map((s) => (
                        <span key={s} className="mr-1.5">
                          · {s}
                        </span>
                      ))}
                    </dd>
                  </div>
                  <div>
                    {/*
                      ★ 验收标准必须是结构化清单，不是自由文本 ——
                        它后续会成为 Review 阶段的自动校验依据。
                    */}
                    <dt className="text-[11px] text-slate-500">
                      {t('requirement.detail.acceptanceCriteria', {
                        count: r.acceptanceCriteria.length,
                      })}
                      <SourceTag source={sourceOf(r, 'acceptanceCriteria')} />
                      {r.acceptanceCriteria.length < 3 && (
                        <span className="ml-1 text-amber-700">
                          {t('requirement.detail.fewCriteria')}
                        </span>
                      )}
                    </dt>
                    <dd>
                      <ul className="space-y-0.5">
                        {r.acceptanceCriteria.map((a, i) => (
                          <li key={i} className="text-slate-700">
                            ☑ {a.text ?? a.description ?? JSON.stringify(a)}
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                </dl>
              )}
            </section>
          </div>

          {/* ★ 澄清问题是 AI 分析的产物，人工路径没有这一块 —— 不是漏了 */}
          {analyzed && clarifications.length > 0 && (
            <Clarifications
              clarifications={clarifications}
              pending={answering}
              readOnly={readOnly}
              onAnswer={(id, a, used) => answer.mutate({ id, answer: a, usedSuggestion: used })}
            />
          )}

          {assumptions.length > 0 && (
            <section className="rounded border border-slate-200 bg-white px-3 py-2">
              <h2 className="text-xs font-medium text-slate-700">
                {t('requirement.detail.assumptions', { count: assumptions.length })}
              </h2>
              <p className="text-[11px] text-slate-400">
                {t('requirement.detail.assumptionsNote')}
              </p>
              <ul className="mt-1 space-y-0.5">
                {assumptions.map((a) => (
                  <li key={a.id} className="text-xs text-slate-600">
                    · {a.answer ?? a.agentSuggestion ?? a.question}
                    {!a.answer && <span className="ml-1 text-[11px] text-slate-400">
                      {t('requirement.detail.unconfirmed')}
                    </span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/*
            ★ 确认与驳回同一档权限（sponsor / pm，§2.3）。
              驳回也是结论 —— 「需求不成立」和「需求成立」都是业务判断，
              把驳回放低一档，等于让没资格拍板的人拍另一半的板。
          */}
          {!editing && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {/*
                ★ 删除对**已驳回**的需求同样开放，而且那才是它最常用的场景 ——
                  「已驳回」列表里堆的正是录错、重复提交、试验数据这些噪音，
                  留着会把真正的驳回结论淹掉。所以它不受 readOnly 约束。
                ★ 权限也与驳回分开：驳回是业务判断（sponsor / pm），
                  删除是对记录本身的处置（pm / tech_lead）。
              */}
              <GatedButton
                permission="requirement.delete"
                onClick={() => setDeleting(true)}
                className="mr-auto text-xs text-red-600 hover:text-red-800"
              >
                {t('common.delete')}
              </GatedButton>
              {structured && !readOnly && (
                <>
                  <GatedButton
                    permission="requirement.approve"
                    onClick={() => setRejecting(true)}
                    className="text-xs text-slate-500 hover:text-slate-800"
                  >
                    {t('requirement.detail.reject')}
                  </GatedButton>
                  <GatedButton
                    permission="requirement.approve"
                    onClick={() => setConfirming(true)}
                    className="rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
                  >
                    {t('requirement.detail.approve')}
                  </GatedButton>
                </>
              )}
            </div>
          )}

          {r.status === 'approved' && (
            <p className="rounded border border-green-200 bg-green-50 px-3 py-1.5 text-xs text-green-900">
              {t('requirement.detail.approvedNote')}
            </p>
          )}
        </div>
      </div>

      {confirming && (
        <ConfirmDialog
          mustConfirmLeft={mustConfirm.length}
          completeness={r.completeness.total ?? 0}
          pending={approve.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => approve.mutate()}
        />
      )}

      {rejecting && (
        <RejectDialog
          pending={reject.isPending}
          onCancel={() => setRejecting(false)}
          onConfirm={(reason) => reject.mutate(reason)}
        />
      )}

      {deleting && (
        <DeleteDialog
          title={r.title ?? r.rawInput.slice(0, 40)}
          pending={remove.isPending}
          onCancel={() => setDeleting(false)}
          onConfirm={() => remove.mutate()}
        />
      )}
    </div>
  );
}

/**
 * 字段名 → 词条键。提示语里出现 businessGoal 这种词等于没说。
 * Field name → message key; a hint that says "businessGoal" says nothing.
 */
const FIELD_KEYS: Record<string, MessageKey> = {
  title: 'requirement.field.title',
  businessContext: 'requirement.field.businessContext',
  userProblem: 'requirement.field.userProblem',
  businessGoal: 'requirement.field.businessGoal',
  userStories: 'requirement.field.userStories',
  scope: 'requirement.field.scope',
  nonFunctional: 'requirement.field.nonFunctional',
  successMetrics: 'requirement.field.successMetrics',
  constraints: 'requirement.field.constraints',
  risks: 'requirement.field.risks',
  acceptanceCriteria: 'requirement.field.acceptanceCriteria',
};

/** 状态 → 词条键。同 List.tsx：模块级常量存键不存译文 */
const STATUS_KEYS: Record<string, MessageKey> = {
  draft: 'requirement.status.draft',
  analyzing: 'requirement.status.analyzing',
  clarifying: 'requirement.status.clarifying',
  awaiting_approval: 'requirement.status.awaiting_approval',
  approved: 'requirement.status.approved',
  rejected: 'requirement.status.rejected',
  on_hold: 'requirement.status.on_hold',
};

/**
 * 这份结果到底是谁产出的。
 *
 * ★★ 没有这一行的时候，界面上写着「🤖 AI 结构化结果」，而底下可能跑的是
 *   关键词规则占位（没配规划 Agent、凭证缺失、Agent 超时都会回退）。
 *   用户拿回自己的原话换了三个标签，只会觉得「这 AI 真差」——
 *   没有任何线索指向「根本没接模型」。
 *
 * ★ 回退时不只说「占位」，把原因一起摆出来：那句话正是解决问题所需的
 *   全部信息（比如「组织内没有可用的规划 Agent」）。藏起来只会变成一张工单。
 */
function AnalysisSource({ model }: { model: string | null }) {
  const t = useT();
  if (!model) return null;

  // 回退时 model 形如 `stub（规则占位，未走 Agent：原因）`，见 agent-provider.ts
  // On fallback the model reads `stub（…未走 Agent：<reason>）` — see agent-provider.ts
  const degraded = model.startsWith('stub');
  if (!degraded) {
    return (
      <span className="text-[11px] text-slate-400">
        {t('requirement.detail.generatedBy', { model })}
      </span>
    );
  }

  /**
   * ★ reason 来自服务端，目前只有中文 —— 界面切成英文时它仍是中文。
   *   包裹它的那句话已经本地化了，所以英文用户至少知道「这是回退，
   *   下面那段是原因」。要彻底解决得让服务端返回结构化的原因码而不是
   *   一句现成的话，那是另一处改动（见 modules/planning/agent-provider.ts）。
   *
   *   The reason string still comes from the server in Chinese. The wrapper
   *   around it is localized, so an English reader can at least tell this is
   *   a fallback and that the tail is the cause. Fixing it properly means
   *   returning a reason code instead of a sentence — a separate change.
   */
  const reason = model.match(/未走 Agent：(.+?)）\s*$/)?.[1] ?? null;
  return (
    <span
      className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800"
      title={reason ?? undefined}
    >
      {reason
        ? t('requirement.detail.stubFallbackWhy', { reason })
        : t('requirement.detail.stubFallback')}
    </span>
  );
}

function Field({
  label,
  value,
  source,
}: {
  label: string;
  value: string | null;
  source: FieldSource;
}) {
  const t = useT();
  return (
    <div>
      <dt className="text-[11px] text-slate-500">
        {label}
        <SourceTag source={source} />
        {!value && (
          <span className="ml-1 text-amber-700">{t('requirement.detail.unrecognized')}</span>
        )}
      </dt>
      <dd className="leading-5 text-slate-700">{value ?? '—'}</dd>
    </div>
  );
}

type FieldSource = 'human' | 'ai' | 'unknown';

/**
 * 这个字段现在是谁写的。
 *
 * ★★ 两条路并行之后，这一行从「锦上添花」变成了必需品。
 *   确认需求时最该看清的就是「这句话是我写的，还是 AI 替我写的」——
 *   前者我为它负责，后者我要先核对。混在一起显示等于把这个判断拿走了。
 *
 * ★ 认不出来的来源如实标成 unknown（不显示），不假装是 AI 也不假装是人写的。
 *   fieldProvenance 里 AI 记的是原文片段（source: 'raw_input'），
 *   人工编辑记的是 source: 'human'（见 routes.ts 的 PATCH）。
 */
function sourceOf(
  r: { fieldProvenance: Record<string, unknown> },
  field: string,
): FieldSource {
  const entry = r.fieldProvenance?.[field] as { source?: string } | undefined;
  if (!entry?.source) return 'unknown';
  return entry.source === 'human' ? 'human' : 'ai';
}

function SourceTag({ source }: { source: FieldSource }) {
  const t = useT();
  if (source === 'unknown') return null;
  return (
    <span
      className={clsx(
        'ml-1 rounded px-1 text-[10px]',
        source === 'human' ? 'bg-sky-50 text-sky-700' : 'bg-slate-100 text-slate-500',
      )}
      title={
        source === 'human' ? t('requirement.detail.fromHuman') : t('requirement.detail.fromAi')
      }
    >
      {source === 'human' ? t('requirement.detail.byHuman') : '🤖 AI'}
    </span>
  );
}

/**
 * 确认前说清楚接下来会发生什么（页面文档 03 §5.7）。
 *
 * ★ 这不是一个「确定吗」的弹窗。用户按下确认后会有一个 Agent 花几分钟、
 *   几毛钱去干活，他有权在按之前就知道这件事。
 */
function ConfirmDialog({
  mustConfirmLeft,
  completeness,
  pending,
  onCancel,
  onConfirm,
}: {
  mustConfirmLeft: number;
  completeness: number;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <Modal onClose={onCancel} title={t('requirement.approve.title')}>
      <h2 className="text-sm font-semibold text-slate-900">{t('requirement.approve.title')}</h2>
      <div className="mt-2 space-y-1 text-xs text-slate-700">
        <p>{t('requirement.approve.intro')}</p>
        <p>{t('requirement.approve.step1')}</p>
        <p>{t('requirement.approve.step2')}</p>
      </div>

      {mustConfirmLeft > 0 && (
        <p className="mt-2 rounded bg-red-50 px-2 py-1.5 text-xs text-red-800">
          {t('requirement.approve.mustConfirmLeft', { count: mustConfirmLeft })}
        </p>
      )}
      {mustConfirmLeft === 0 && completeness < 60 && (
        <p className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          {t('requirement.approve.lowCompleteness', { score: completeness })}
        </p>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="text-xs text-slate-500">
          {t('requirement.approve.backToEdit')}
        </button>
        <Button variant="neutral" size="sm"
          onClick={onConfirm}
          disabled={pending}>
          {pending ? t('requirement.approve.generating') : t('requirement.approve.confirm')}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * 删除确认。
 *
 * ★ 要把标题回显出来 —— 从列表点进来再点删除，用户未必记得自己在哪一条上。
 * ★ 也要说清「这不是驳回」：两个动作在同一排按钮里，选错的代价不对称。
 */
function DeleteDialog({
  title,
  pending,
  onCancel,
  onConfirm,
}: {
  title: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <Modal onClose={onCancel} title={t('requirement.delete.one.title')}>
      <h2 className="text-sm font-semibold text-slate-900">
        {t('requirement.delete.one.title')}
      </h2>
      <p className="mt-2 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-700">
        {title}
      </p>
      <p className="mt-2 text-xs text-slate-500">
        {t('requirement.delete.warning')}{' '}
        <span className="text-red-600">{t('requirement.delete.irreversible')}</span>{' '}
        {t('requirement.delete.notRejection')}
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="text-xs text-slate-500">
          {t('common.cancel')}
        </button>
        <Button variant="destructive" size="sm" onClick={onConfirm} disabled={pending}>
          {pending ? t('common.deleting') : t('requirement.delete.confirm')}
        </Button>
      </div>
    </Modal>
  );
}

function RejectDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const t = useT();
  return (
    <Modal onClose={onCancel} title={t('requirement.reject.title')}>
      <h2 className="text-sm font-semibold text-slate-900">{t('requirement.reject.title')}</h2>
      {/* ★ 必填原因：提出人要知道为什么，否则只会原样再提一遍 */}
      <p className="mt-1 text-xs text-slate-500">{t('requirement.reject.help')}</p>
      <Textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        className="mt-2"
      />
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="text-xs text-slate-500">
          {t('common.cancel')}
        </button>
        <Button variant="neutral" size="sm"
          onClick={() => onConfirm(reason.trim())}
          disabled={!reason.trim() || pending}>
          {t('requirement.reject.confirm')}
        </Button>
      </div>
    </Modal>
  );
}
