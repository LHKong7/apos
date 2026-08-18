import { useT, type MessageKey } from '../../lib/i18n';
import { useState } from 'react';
import type { RequirementDetail } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * 人工填写 / 修改结构化需求（页面文档 03 §5.4）。
 *
 * ★★ 人工与 AI 是**并行**的两条路，不是「AI 出稿、人打补丁」。
 *
 *   需求本来就写得清楚、组织里压根没配规划 Agent、分析超时（产品文档
 *   03 §7 明确要求「取消并转人工填写」）—— 这三种情况下，能不能不跑
 *   分析直接把需求填出来，决定了这一页是能用还是只能干等。
 *
 * ★ 暴露的字段刚好覆盖完整度的六个维度里人能改的五个（依赖那一维由
 *   未回答的必答问题决定）。少给一个，人工路径就永远拿不到满分 ——
 *   而用户正是照着那个分数判断「够不够格确认」的。
 *
 * ★ 一次提交整份，不做字段级锁。多人同时编辑同一条需求时后写的赢，
 *   这是当前实现的**已知边界**（产品文档 03 §9 的字段级乐观锁还没做），
 *   不假装它不存在。
 */

/** 页面上按「一行一条」编辑的列表字段 */
function toLines(items: unknown[] | undefined): string {
  return (items ?? []).map((i) => (typeof i === 'string' ? i : JSON.stringify(i))).join('\n');
}

function fromLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export interface RequirementPatch {
  title: string;
  businessContext: string;
  userProblem: string;
  businessGoal: string;
  scope: { inScope: string[]; outOfScope: string[] };
  risks: string[];
  acceptanceCriteria: { id?: string; text: string; verification: 'auto' | 'agent' | 'human' }[];
}

type Criterion = RequirementPatch['acceptanceCriteria'][number];

const VERIFICATION_KEYS: Record<Criterion['verification'], MessageKey> = {
  auto: 'editor.verifyAuto',
  agent: 'editor.verifyAgent',
  human: 'editor.verifyHuman',
};

export function StructuredEditor({
  requirement: r,
  saving,
  error,
  onSave,
  onCancel,
}: {
  requirement: RequirementDetail['requirement'];
  saving: boolean;
  error: string | null;
  onSave: (patch: RequirementPatch) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [title, setTitle] = useState(r.title ?? '');
  const [businessContext, setBusinessContext] = useState(r.businessContext ?? '');
  const [userProblem, setUserProblem] = useState(r.userProblem ?? '');
  const [businessGoal, setBusinessGoal] = useState(r.businessGoal ?? '');
  const [inScope, setInScope] = useState(toLines(r.scope?.inScope));
  const [outOfScope, setOutOfScope] = useState(toLines(r.scope?.outOfScope));
  const [risks, setRisks] = useState(toLines(r.risks));
  const [criteria, setCriteria] = useState<Criterion[]>(() =>
    (r.acceptanceCriteria ?? []).map((c) => ({
      ...(c.id ? { id: c.id } : {}),
      text: c.text ?? c.description ?? '',
      /**
       * ★ 保留原有的核验方式，缺失才落到 human。
       *   AI 判定为 auto 的标准被人改了一个错别字就降级成人工核验的话，
       *   Review 阶段会凭空多出一堆等人点的活。
       */
      verification: normalizeVerification((c as { verification?: string }).verification),
    })),
  );

  const setCriterion = (i: number, patch: Partial<Criterion>) =>
    setCriteria((list) => list.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  const submit = () =>
    onSave({
      title: title.trim(),
      businessContext: businessContext.trim(),
      userProblem: userProblem.trim(),
      businessGoal: businessGoal.trim(),
      scope: { inScope: fromLines(inScope), outOfScope: fromLines(outOfScope) },
      risks: fromLines(risks),
      // 空行不提交 —— 服务端会拒掉空文本的标准，那条报错对用户毫无意义
      acceptanceCriteria: criteria
        .filter((c) => c.text.trim())
        .map((c) => ({ ...c, text: c.text.trim() })),
    });

  return (
    <div className="mt-1 space-y-2 text-xs">
      <Labeled label={t('editor.title')}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('editor.titleHelp')} />
      </Labeled>

      <Labeled label={t('editor.context')} help={t('editor.contextHelp')}>
        <Textarea
          value={businessContext}
          onChange={(e) => setBusinessContext(e.target.value)}
          rows={3}
        />
      </Labeled>

      <Labeled label={t('editor.problem')}>
        <Textarea value={userProblem} onChange={(e) => setUserProblem(e.target.value)} rows={2} />
      </Labeled>

      <Labeled label={t('editor.goal')} help={t('editor.goalHelp')}>
        <Textarea value={businessGoal} onChange={(e) => setBusinessGoal(e.target.value)} rows={2} />
      </Labeled>

      <div className="grid gap-2 sm:grid-cols-2">
        <Labeled label={t('editor.inScope')}>
          <Textarea value={inScope} onChange={(e) => setInScope(e.target.value)} rows={3} />
        </Labeled>
        {/*
          ★ 「不做什么」和「做什么」一样重要：没写出来的边界，
            Agent 会自己划一条，而它划在哪你事后才知道。
        */}
        <Labeled label={t('editor.outOfScope')} help={t('editor.outOfScopeHelp')}>
          <Textarea value={outOfScope} onChange={(e) => setOutOfScope(e.target.value)} rows={3} />
        </Labeled>
      </div>

      <div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-slate-600">{t('editor.acceptance')}</span>
          <span className="text-[11px] text-slate-400">
            {t('editor.acceptanceHint')}
          </span>
          <Button variant="ghost"
            onClick={() => setCriteria((l) => [...l, { text: '', verification: 'human' }])}
            className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent ml-auto text-[11px] text-slate-500 underline hover:text-slate-700"
          >
            {t('editor.addCriterion')}
          </Button>
        </div>
        <div className="mt-1 space-y-1">
          {criteria.length === 0 && (
            <p className="text-[11px] text-amber-700">
              {t('editor.noCriteriaWarning')}
            </p>
          )}
          {criteria.map((c, i) => (
            <div key={i} className="flex items-center gap-1">
              <Input
                value={c.text}
                onChange={(e) => setCriterion(i, { text: e.target.value })}
                placeholder={t('editor.acceptancePlaceholder')}
              />
              {/*
                ★ 核验方式必须由人指定，且默认「人工」。
                  平台没有依据认定一条自由文本能被自动核验，
                  默认成 auto 等于替用户许了一个他没许的承诺。
              */}
              <Select
                value={c.verification}
                onValueChange={(v) =>
                  setCriterion(i, { verification: v as Criterion['verification'] })
                }
              >
                <SelectTrigger className="w-auto shrink-0 px-1.5 text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['auto', 'agent', 'human'] as const).map((v) => (
                    <SelectItem key={v} value={v}>
                      {t(VERIFICATION_KEYS[v])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="ghost"
                onClick={() => setCriteria((l) => l.filter((_, idx) => idx !== i))}
                className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent shrink-0 px-1 text-[11px] text-slate-400 hover:text-rose-600"
                aria-label={t('editor.removeCriterion', { n: i + 1 })}
              >
                ✕
              </Button>
            </div>
          ))}
        </div>
      </div>

      <Labeled label={t('editor.risks')} help={t('editor.risksHelp')}>
        <Textarea value={risks} onChange={(e) => setRisks(e.target.value)} rows={2} />
      </Labeled>

      {error && <p className="text-[11px] text-rose-600">{error}</p>}

      <div className="flex justify-end gap-2 border-t border-slate-100 pt-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button variant="neutral" size="sm" onClick={submit} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </Button>
      </div>
    </div>
  );
}

/** 库里存的可能是 AI 写的任意字符串，认不出来就按人工核验 —— 不静默当成自动 */
function normalizeVerification(v: string | undefined): Criterion['verification'] {
  return v === 'auto' || v === 'agent' || v === 'human' ? v : 'human';
}

function Labeled({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <Label className="block">
      <span className="text-[11px] font-medium text-slate-600">{label}</span>
      {help && <span className="ml-1 text-[11px] text-slate-400">{help}</span>}
      <div className="mt-0.5">{children}</div>
    </Label>
  );
}
