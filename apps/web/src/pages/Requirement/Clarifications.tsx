import { useT, type MessageKey } from '../../lib/i18n';
import { useState } from 'react';
import clsx from 'clsx';
import type { Clarification } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

/**
 * 澄清问题（页面文档 03 §5.5）—— 本页最重要的设计。
 *
 * ★ 如果澄清问题让用户觉得「AI 在考我」，产品就失败了。
 *   每个必答问题都要让他觉得「它已经想好了，只是需要我拍个板」。
 *   所以每条必须给齐三样：不回答会怎样、Agent 倾向是什么、依据是什么。
 *   缺了「倾向」的提问就是在考人；缺了「依据」的倾向不值得采纳。
 */

const LEVEL_META = {
  must_confirm: {
    icon: '🔴',
    labelKey: 'clarify.mustConfirm' as MessageKey,
    className: 'border-red-200 bg-red-50',
    order: 0,
  },
  default_applicable: {
    icon: '🟡',
    labelKey: 'clarify.defaultOk' as MessageKey,
    className: 'border-amber-200 bg-amber-50',
    order: 1,
  },
  assumption_ok: {
    icon: '🔵',
    labelKey: 'clarify.assumptionOk' as MessageKey,
    className: 'border-sky-200 bg-sky-50',
    order: 2,
  },
  auto_resolved: {
    icon: '🟢',
    labelKey: 'clarify.autoResolved' as MessageKey,
    className: 'border-slate-200 bg-slate-50',
    order: 3,
  },
} as const;

export function Clarifications({
  clarifications,
  onAnswer,
  pending,
  readOnly,
}: {
  clarifications: Clarification[];
  onAnswer: (id: string, answer: string, usedSuggestion: boolean) => void;
  pending: string | null;
  readOnly: boolean;
}) {
  const t = useT();
  const [expandResolved, setExpandResolved] = useState(false);

  if (clarifications.length === 0) {
    return (
      <p className="rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-400">
        {t('clarify.none')}
      </p>
    );
  }

  const sorted = [...clarifications].sort(
    (a, b) => LEVEL_META[a.level].order - LEVEL_META[b.level].order,
  );
  const resolved = sorted.filter((c) => c.level === 'auto_resolved');
  const active = sorted.filter((c) => c.level !== 'auto_resolved');
  const unanswered = active.filter((c) => c.level === 'must_confirm' && !c.answer).length;
  /** ★ 已答的算上 auto_resolved：它们对用户而言也是「不用管了」的那一类 */
  const answeredCount = clarifications.filter(
    (c) => c.answer !== null || c.level === 'auto_resolved',
  ).length;

  return (
    <section className="rounded border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-1.5">
        {/*
          ★★ 标题此前恒是「Needs clarification (4)」—— 答完两条它还是 4，
            而下面明明只剩两条开着。数字与眼前所见对不上时，用户信眼睛，
            于是这个数字变成噪声。改成说进度：答了几条、一共几条。
        */}
        <h2 className="text-xs font-medium text-slate-700">
          {answeredCount > 0
            ? t('clarify.titleProgress', {
                answered: answeredCount,
                count: clarifications.length,
              })
            : t('clarify.title', { count: clarifications.length })}
        </h2>
        {unanswered > 0 && (
          <span className="text-[11px] text-red-700">{t('clarify.unanswered', { count: unanswered })}</span>
        )}
        {resolved.length > 0 && (
          <Button variant="ghost"
            onClick={() => setExpandResolved((v) => !v)}
            className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent ml-auto text-[11px] text-slate-500 underline"
          >
            {expandResolved ? t('clarify.collapse') : t('clarify.autoResolvedCount', { count: resolved.length })}
          </Button>
        )}
      </div>

      <ul className="divide-y divide-slate-100">
        {active.map((c) => (
          <Question
            key={c.id}
            clarification={c}
            onAnswer={onAnswer}
            pending={pending === c.id}
            readOnly={readOnly}
          />
        ))}
        {expandResolved &&
          resolved.map((c) => (
            <li key={c.id} className="px-3 py-1.5 text-xs">
              <span aria-hidden>🟢</span> {c.question}
              <span className="ml-2 text-slate-500">→ {c.answer}</span>
              {c.resolvedSource && (
                <span className="ml-1 text-[11px] text-slate-400">{t('clarify.fromSource', { source: c.resolvedSource })}</span>
              )}
            </li>
          ))}
      </ul>
    </section>
  );
}

function Question({
  clarification: c,
  onAnswer,
  pending,
  readOnly,
}: {
  clarification: Clarification;
  onAnswer: (id: string, answer: string, usedSuggestion: boolean) => void;
  pending: boolean;
  readOnly: boolean;
}) {
  const t = useT();
  const [custom, setCustom] = useState('');
  const meta = LEVEL_META[c.level];
  const options = (c.options as { label?: string; value?: string }[]).filter(
    (o) => typeof o === 'object' && o !== null,
  );

  if (c.answer) {
    return (
      <li className="px-3 py-1.5 text-xs">
        <span aria-hidden>✓</span>
        <span className="ml-1 text-slate-500">{c.question}</span>
        <span className="ml-2 font-medium text-slate-800">{c.answer}</span>
      </li>
    );
  }

  return (
    <li className={clsx('border-l-2 px-3 py-2', meta.className)}>
      <p className="text-xs">
        <span aria-hidden>{meta.icon}</span>
        <span className="ml-1 font-medium text-slate-500">{t(meta.labelKey)}</span>
        <span className="ml-2 text-slate-900">{c.question}</span>
      </p>

      {/* ★ 不回答会怎样 —— 把紧迫性从「有个问题」变成具体的工期影响 */}
      {c.impact && <p className="mt-0.5 text-[11px] text-slate-600">{t('clarify.impact', { impact: c.impact })}</p>}

      {/* ★ Agent 倾向 + 依据。只提问不给建议，就是在考用户 */}
      {c.agentSuggestion && (
        <p className="mt-0.5 text-[11px] text-slate-600">
          {t('clarify.agentLeans')}
          <span className="text-slate-800">{c.agentSuggestion}</span>
          {c.suggestionBasis && <span className="text-slate-400">{t('clarify.basis', { basis: c.suggestionBasis })}</span>}
        </p>
      )}

      {!readOnly && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {c.agentSuggestion && (
            <Button variant="neutral" size="xs"
              disabled={pending}
              onClick={() => onAnswer(c.id, c.agentSuggestion!, true)}>
              {c.level === 'default_applicable' ? t('clarify.acceptDefault') : t('clarify.acceptSuggestion')}
            </Button>
          )}
          {options.map((o, i) => {
            const text = o.label ?? o.value ?? String(o);
            return (
              <Button variant="ghost"
                key={`${text}-${i}`}
                disabled={pending}
                onClick={() => onAnswer(c.id, text, false)}
                className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {text}
              </Button>
            );
          })}
          {/*
            ★★ 这里是**设计决定**的输入口，答案会随需求一路传给每个下游 Agent。
              此前它是一个 160px 的单行框：一句 79 字的回答只看得见结尾
              「…through — no reordering」，用户没法复读自己写了什么。
              改成整行宽的 textarea，并把「Enter 提交、Shift+Enter 换行」
              这条约定写在旁边 —— 不写的话，想换行的人会先误提交一次。
          */}
          <div className="mt-1 basis-full">
            <Textarea
              value={custom}
              rows={2}
              aria-label={t('clarify.writeYourOwn')}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && custom.trim()) {
                  e.preventDefault();
                  onAnswer(c.id, custom.trim(), false);
                }
              }}
              placeholder={t('clarify.writeYourOwn')}
              className="w-full text-xs"
            />
            <p className="mt-0.5 text-[10px] text-slate-400">{t('clarify.submitHint')}</p>
          </div>
          {custom.trim() && (
            <Button variant="ghost"
              disabled={pending}
              onClick={() => onAnswer(c.id, custom.trim(), false)}
              className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700"
            >
              {t('clarify.submit')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
