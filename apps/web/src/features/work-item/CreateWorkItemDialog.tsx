import { useT, type MessageKey } from '../../lib/i18n';
import { useState } from 'react';
import { confirmClose, useUnsavedGuard } from '../../lib/useUnsavedGuard';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { Modal } from './ManualMoveDialog';
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

const TYPES: { value: string; labelKey: MessageKey }[] = [
  { value: 'task', labelKey: 'createItem.type.task' },
  { value: 'bug', labelKey: 'createItem.type.bug' },
  { value: 'feature', labelKey: 'createItem.type.feature' },
  { value: 'story', labelKey: 'createItem.type.story' },
  { value: 'research', labelKey: 'createItem.type.research' },
  { value: 'review', labelKey: 'createItem.type.review' },
  { value: 'test', labelKey: 'createItem.type.test' },
  { value: 'incident', labelKey: 'createItem.type.incident' },
  { value: 'knowledge', labelKey: 'createItem.type.knowledge' },
];

const PRIORITIES: { value: number; labelKey: MessageKey }[] = [
  { value: 0, labelKey: 'priority.p0' },
  { value: 1, labelKey: 'priority.p1' },
  { value: 2, labelKey: 'priority.p2' },
  { value: 3, labelKey: 'priority.p3' },
];

export function CreateWorkItemDialog({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const t = useT();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('task');
  const [priority, setPriority] = useState(2);
  const [riskLevel, setRiskLevel] = useState('low');

  /**
   * ★ 「改过」= 用户真的写进去了东西，不是「打开过这个弹窗」。
   *   下拉框的默认值不算改动 —— 拿它当改动的话，一个刚打开就想关掉的
   *   弹窗也会弹确认，而用户三次之后就会条件反射地点确认（问题记录 #26）。
   */
  const dirty = title.trim().length > 0 || description.trim().length > 0;
  useUnsavedGuard(dirty);
  const close = () => {
    if (confirmClose(dirty)) onClose();
  };
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
    <Modal onClose={close} title={t('createItem.title')}>
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">{t('createItem.title')}</h2>

        <Label className="block">
          <span className="text-xs font-medium text-slate-700">{t('createItem.titleField')}</span>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('createItem.titlePlaceholder')}
            className="mt-1" />
        </Label>

        {/*
          ★ 三个下拉用 htmlFor 关联而不是包在 label 里：Radix 的触发器是
            <Button variant="ghost" className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent">，包起来点标签文字打不开下拉（同 Settings/primitives 里
            那条注释）。文本框那两格仍然是包着的 —— 原生控件包着才对。

            The three dropdowns associate by htmlFor rather than wrapping: a
            Radix trigger is a button, and a wrapping label would leave the
            label text dead. The text fields stay wrapped.
        */}
        <div className="grid grid-cols-3 gap-2">
          <div>
            <Label htmlFor="new-item-type" className="text-slate-700">
              {t('createItem.type')}
            </Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="new-item-type" className="mt-1 bg-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* ★ 参数不叫 t —— 会遮住 i18n 的 t */}
                {TYPES.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {t(opt.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="new-item-priority" className="text-slate-700">
              {t('createItem.priority')}
            </Label>
            {/* ★ 优先级是 number，Radix 的 value 只认字符串 —— 两边都显式转 */}
            <Select value={String(priority)} onValueChange={(v) => setPriority(Number(v))}>
              <SelectTrigger id="new-item-priority" className="mt-1 bg-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((opt) => (
                  <SelectItem key={opt.value} value={String(opt.value)}>
                    {t(opt.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="new-item-risk" className="text-slate-700">
              {t('createItem.risk')}
            </Label>
            <Select value={riskLevel} onValueChange={setRiskLevel}>
              <SelectTrigger id="new-item-risk" className="mt-1 bg-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">{t('createItem.riskLow')}</SelectItem>
                <SelectItem value="medium">{t('createItem.riskMedium')}</SelectItem>
                <SelectItem value="high">{t('createItem.riskHigh')}</SelectItem>
                <SelectItem value="critical">{t('createItem.riskCritical')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <Label className="block">
          <span className="text-xs font-medium text-slate-700">
            {t('createItem.description')}
            <span className="ml-1 font-normal text-slate-400">{t('login.field.optional')}</span>
          </span>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="mt-1"
          />
        </Label>

        {/*
          ★★ 这句话不是提示，是这个入口能存在的**条件**。
            手工建的任务如果建完就能派发，任何能建任务的人都可以让 Agent
            去做任意事情 —— 两道 Human Gate 就都被绕开了。
        */}
        <p className="rounded bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800">
          {t('createItem.gateWarning', { status: t('createItem.draft') })}
        </p>

        {create.error instanceof ApiError && (
          <p className="text-xs text-rose-600">{create.error.message}</p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm"
            onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="neutral" size="sm"
            disabled={!title.trim() || create.isPending}
            onClick={() => create.mutate()}>
            {create.isPending ? t('createItem.creating') : t('createItem.submit')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
