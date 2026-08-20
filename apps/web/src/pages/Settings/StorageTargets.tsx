import { useState } from 'react';
import { joinList } from '@/lib/format';
import { useMutation } from '@tanstack/react-query';
import clsx from 'clsx';
import { hasMessage, t, type MessageKey } from '../../lib/i18n';
import { ApiError, api } from '../../lib/api/client';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import type { StorageTargetRow } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Field, Labeled, StatusDot } from './primitives';
import { Label } from '@/components/ui/label';
import {
  SELECT_EMPTY,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  fromSelectValue,
  toSelectValue,
} from '@/components/ui/select';

/**
 * 存储目标 —— 非 Git 的工作区来源：对象存储桶 / 宿主机目录。
 *
 * ★★ 这个文件里只剩**组件**，页面在 WorkspaceSources.tsx。
 *
 *   存储目标曾经是「Agent 配置」下面的第四个标签页，先被拆成独立一页，
 *   现在与代码仓库合并成「工作区来源」—— 两类都不是某个 Agent 的属性，
 *   而是项目（或组织）级的资源登记，回答的是同一个问题：
 *   Agent 的活儿从哪来、产出去哪。
 *
 * ★ 与代码仓库同处一页但**各自一张表单**：两类的字段完全不重叠
 *   （bucket / 寻址风格 vs 默认分支 / 分支前缀），混在一张表单里，
 *   不适用的那半边只能显示成灰掉的占位符 —— 而占位符会被当成真实配置。
 *
 * Components only; the page lives in WorkspaceSources.tsx. Same page as
 * repositories, separate forms — the two kinds share no fields, and a
 * greyed-out placeholder reads as real configuration.
 */


/** 存储目标类型 → 词条键 / Storage target kind → message key（模块级只存键） */
export const TARGET_KIND_KEYS: Record<StorageTargetRow['kind'], MessageKey> = {
  object_storage: 'storage.objectStorage',
  local: 'storage.localDir',
};

/**
 * 「产出交货到哪」选择器 —— 存储目标与代码仓库两张表单共用。
 *
 * ★ 从 AgentConfig 一起搬过来并导出：它讲的是存储目标（候选、可写性、
 *   寻址），只是**恰好**也被仓库表单用到。留在那边的话，这一页反过来
 *   要 import 那一页。
 *
 * ★★ 只列**可写**的存储目标。只读的目标在收尾时会被原样跳过，
 *   摆在这里可选就是在邀请用户配一个不会生效的值 —— 而那种失败
 *   （任务成功、产物页有记录、目标里什么都没有）极难自己想到。
 */
export function DeliveryTargetPicker({
  value,
  onChange,
  targets,
  selfId,
  defaultLabel,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  targets: StorageTargetRow[];
  /** 编辑存储目标自身时传，用来把自己从候选里去掉 */
  selfId?: string;
  /** 不选时的默认行为说明 */
  defaultLabel: string;
}) {
  const options = targets.filter((t) => t.writable && t.status === 'active' && t.id !== selfId);
  const chosen = options.find((t) => t.id === value);

  return (
    <Labeled
      label={t('agentCfg.delivery.label')}
      help={
        chosen
          ? t('agentCfg.delivery.help', {
              where:
                chosen.kind === 'object_storage'
                  ? `${chosen.bucket}/${chosen.prefix}`
                  : (chosen.rootPath ?? ''),
            })
          : defaultLabel
      }
    >
      <Select
        value={toSelectValue(value)}
        onValueChange={(v) => onChange(fromSelectValue(v) || null)}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={SELECT_EMPTY}>
            {t('agentCfg.delivery.default', { label: defaultLabel })}
          </SelectItem>
          {options.map((target) => (
            <SelectItem key={target.id} value={target.id}>
              {target.ref} · {t(TARGET_KIND_KEYS[target.kind])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {options.length === 0 && (
        <p className="mt-1 text-[11px] text-slate-500">{t('agentCfg.noWritableTargets')}</p>
      )}
    </Labeled>
  );
}

export function StorageTargetCard({
  target,
  onDelete,
  onEdit,
  error,
}: {
  target: StorageTargetRow;
  onDelete: () => void;
  onEdit: () => void;
  error: unknown;
}) {
  const probe = useMutation({ mutationFn: () => api.probeStorageTarget(target.id) });
  const result = probe.data;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-800">
          {target.ref}
        </code>
        <span className="text-sm text-slate-900">{target.name}</span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
          {t(TARGET_KIND_KEYS[target.kind])}
        </span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
          {target.scope === 'project' ? t('storage.scopeProject') : t('storage.scopeOrg')}
        </span>
        {/*
          ★ 可写与否要在卡片上一眼看到：只读挂载在交货阶段会被原样跳过，
            而「登记成只读却指望它接收产物」的表现是「任务成功但里面什么都没有」。
        */}
        <StatusDot
          tone={target.writable ? 'ok' : 'warning'}
          label={target.writable ? t('agentCfg.writable') : t('agentCfg.readOnly')}
        />
        <div className="ml-auto flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            disabled={probe.isPending}
            onClick={() => probe.mutate()}
          >
            {probe.isPending ? t('storage.probing') : t('storage.probe')}
          </Button>
          <Button variant="outline" size="sm" onClick={onEdit}>
            {t('common.edit')}
          </Button>
          <Button variant="outline" size="sm" onClick={onDelete}>
            {t('common.delete')}
          </Button>
        </div>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-3">
        {target.kind === 'object_storage' ? (
          <>
            <Field label={t('storage.endpoint')}>{target.endpoint ?? '—'}</Field>
            <Field label={t('storage.bucketPrefix')}>
              {`${target.bucket ?? '—'}/${target.prefix}`}
            </Field>
            <Field label={t('storage.region')}>{target.region}</Field>
            <Field label={t('storage.addressing')}>
              {target.forcePathStyle ? t('storage.pathStyle') : 'virtual-host'}
            </Field>
            <Field label={t('storage.credential')}>
              {target.credentialHint ?? t('storage.unset')}
            </Field>
          </>
        ) : (
          <>
            <Field label={t('storage.rootPath')}>{target.rootPath ?? '—'}</Field>
            <Field label={t('storage.status')}>{target.status}</Field>
          </>
        )}
      </dl>

      {target.credentialProblem && (
        <p className="mt-1 text-[11px] text-rose-600">{target.credentialProblem}</p>
      )}

      {target.warnings.map((w) => (
        <p key={w} className="mt-1 text-[11px] text-amber-700">
          ⚠ {w}
        </p>
      ))}

      {error instanceof ApiError && (
        <p className="mt-1 text-[11px] text-rose-600">{error.message}</p>
      )}

      {result && (
        <div
          className={clsx(
            'mt-2 rounded border px-2 py-1.5 text-[11px] whitespace-pre-wrap',
            result.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-rose-200 bg-rose-50 text-rose-700',
          )}
        >
          {result.message}
          {result.samples.length > 0 && (
            <p className="mt-1 text-slate-500">
              {t('storage.samples', { samples: joinList(result.samples.slice(0, 5)) })}
            </p>
          )}
        </div>
      )}
      {probe.error instanceof ApiError && (
        <p className="mt-1 text-[11px] text-rose-600">{probe.error.message}</p>
      )}
    </div>
  );
}

/**
 * 服务端错误的说法。
 *
 * ★ 服务端带了 `{ code, params }` 时按码取词，取不到才回落到它那句中文。
 *   直接画 `error.message` 的代价是：一条本该指导用户改输入的校验错误，
 *   在英文界面上是一整句中文。
 */
function apiErrorText(e: ApiError): string {
  const d = e.details as { code?: string; params?: Record<string, string | number> } | undefined;
  const key = `storage.error.${d?.code}` as MessageKey;
  return d?.code && hasMessage(key) ? t(key, d.params ?? {}) : e.message;
}

export function StorageTargetForm({
  projectId,
  existing,
  initialKind,
  targets,
  encryptsInline,
  onClose,
  onDone,
}: {
  projectId: string;
  /** 传了就是编辑；标识与类型不可改 */
  existing?: StorageTargetRow | null;
  /**
   * 新建时的初始类型。
   *
   * ★ 工作区来源页在打开表单**之前**就问过类型了（KindPicker），
   *   带进来省掉用户再选一次 —— 而「选完类型，表单里的类型又回到默认值」
   *   会让人以为刚才那一步没生效。编辑时忽略：类型不可改。
   */
  initialKind?: StorageTargetRow['kind'];
  /** 交货目标的候选 */
  targets: StorageTargetRow[];
  encryptsInline: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const isEdit = Boolean(existing);
  const [form, setForm] = useState({
    ref: existing?.ref ?? '',
    name: existing?.name ?? '',
    kind: existing?.kind ?? initialKind ?? ('object_storage' as StorageTargetRow['kind']),
    endpoint: existing?.endpoint ?? '',
    region: existing?.region ?? 'us-east-1',
    bucket: existing?.bucket ?? '',
    prefix: existing?.prefix ?? '',
    forcePathStyle: existing?.forcePathStyle ?? true,
    rootPath: existing?.rootPath ?? '',
    writable: existing?.writable ?? false,
    credential: '',
    orgWide: existing ? existing.scope === 'organization' : false,
  });
  const [deliveryTargetId, setDeliveryTargetId] = useState(existing?.deliveryTargetId ?? null);

  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const isObject = form.kind === 'object_storage';

  const save = useMutation({
    mutationFn: () =>
      isEdit
        ? api.updateStorageTarget(existing!.id, {
            name: form.name,
            writable: form.writable,
            deliveryTargetId,
            ...(isObject
              ? {
                  endpoint: form.endpoint.trim(),
                  region: form.region.trim() || 'us-east-1',
                  bucket: form.bucket.trim(),
                  prefix: form.prefix.trim(),
                  forcePathStyle: form.forcePathStyle,
                }
              : { rootPath: form.rootPath.trim() }),
            // 留空 = 不改凭证（避免编辑别的字段时把凭证清掉）
            ...(form.credential.trim() ? { credential: form.credential.trim() } : {}),
          })
        : api.createStorageTarget({
            ref: form.ref.trim(),
            name: form.name,
            kind: form.kind,
            writable: form.writable,
            deliveryTargetId,
            ...(isObject
              ? {
                  endpoint: form.endpoint.trim(),
                  region: form.region.trim() || 'us-east-1',
                  bucket: form.bucket.trim(),
                  prefix: form.prefix.trim(),
                  forcePathStyle: form.forcePathStyle,
                  credential: form.credential.trim() || null,
                }
              : { rootPath: form.rootPath.trim() }),
            projectId: form.orgWide ? null : projectId,
          }),
    onSuccess: onDone,
  });

  const incomplete = isObject
    ? !form.endpoint.trim() || !form.bucket.trim()
    : !form.rootPath.trim();

  return (
    <Modal
      onClose={onClose}
      title={t('storage.dialogTitle')}
      width="lg"
      footer={
        <div className="space-y-2">
          {save.error instanceof ApiError && (
            <p className="text-xs text-rose-600">{apiErrorText(save.error)}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="neutral"
              size="sm"
              disabled={
                (!isEdit && !form.ref.trim()) || !form.name.trim() || incomplete || save.isPending
              }
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? t('common.saving')
                : isEdit
                  ? t('common.save')
                  : t('storage.registerAction')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">
          {isEdit ? t('storage.editNamed', { name: existing!.name }) : t('storage.registerShort')}
        </h2>

        <Labeled label={t('storage.ref')} help={t('storage.refHelp')}>
          <Input
            value={form.ref}
            disabled={isEdit}
            onChange={(e) => set('ref', e.target.value)}
            placeholder="training-set"
            className="disabled:bg-slate-50 disabled:text-slate-500"
          />
        </Labeled>

        <Labeled label={t('storage.displayName')}>
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} />
        </Labeled>

        {/*
          ★ 类型登记后不可改：两类的必填列完全不重叠，改一半会被库约束
            整个拒掉，而报错指向的是约束名不是字段。要换就删了重建 ——
            那条路上还有「有没有 Agent 授权指向它」这道检查。
        */}
        <Labeled
          label={t('storage.kind')}
          {...(isEdit ? { help: t('storage.kindLocked') } : {})}
        >
          <div className="flex gap-1.5">
            {(['object_storage', 'local'] as const).map((k) => (
              <Button
                key={k}
                variant={form.kind === k ? 'neutral' : 'outline'}
                size="sm"
                disabled={isEdit}
                onClick={() => set('kind', k)}
              >
                {t(TARGET_KIND_KEYS[k])}
              </Button>
            ))}
          </div>
        </Labeled>

        {isObject ? (
          <>
            <Labeled label={t('storage.endpointField')} help={t('storage.endpointHelp')}>
              <Input
                value={form.endpoint}
                onChange={(e) => set('endpoint', e.target.value)}
                placeholder="https://s3.us-east-1.amazonaws.com"
              />
            </Labeled>

            <div className="grid grid-cols-2 gap-2">
              <Labeled label="Bucket">
                <Input value={form.bucket} onChange={(e) => set('bucket', e.target.value)} />
              </Labeled>
              <Labeled label={t('storage.region')}>
                <Input value={form.region} onChange={(e) => set('region', e.target.value)} />
              </Labeled>
            </div>

            <Labeled label={t('storage.prefix')} help={t('storage.prefixHelp')}>
              <Input
                value={form.prefix}
                onChange={(e) => set('prefix', e.target.value)}
                placeholder="datasets/train/"
              />
            </Labeled>

            {/*
              ★★ 寻址风格选反了的表现是 DNS 解析失败，而那条报错里没有任何
                东西指向「寻址风格」。所以默认打开路径风格，并在这里说清楚
                什么时候该关掉。
            */}
            <Label className="flex items-start gap-2 text-xs text-slate-700">
              <Checkbox
                checked={form.forcePathStyle}
                onCheckedChange={(v) => set('forcePathStyle', v)}
              />
              <span>
                {t('storage.pathStyleLabel')}
                <span className="mt-0.5 block text-[11px] text-slate-500">
                  {t('storage.pathStyleHint')}
                </span>
              </span>
            </Label>

            <Labeled
              label={isEdit ? t('storage.rotateCredential') : t('storage.credential')}
              help={
                (encryptsInline
                  ? t('storage.credentialEncrypted')
                  : t('storage.credentialPlaintext')) + t('storage.credentialEnv')
              }
            >
              <Input
                type="password"
                value={form.credential}
                onChange={(e) => set('credential', e.target.value)}
                placeholder="AKIA…:wJalrXUt…"
              />
            </Labeled>
          </>
        ) : (
          <Labeled label={t('storage.rootPathField')} help={t('storage.rootPathHelp')}>
            <Input
              value={form.rootPath}
              onChange={(e) => set('rootPath', e.target.value)}
              placeholder="/srv/data/training-set"
            />
          </Labeled>
        )}

        <Label className="flex items-start gap-2 text-xs text-slate-700">
          <Checkbox checked={form.writable} onCheckedChange={(v) => set('writable', v)} />
          <span>
            {t('agentCfg.writable')}
            <span className="mt-0.5 block text-[11px] text-slate-500">
              {t('storage.writableHint')}
            </span>
          </span>
        </Label>

        <DeliveryTargetPicker
          value={deliveryTargetId}
          onChange={setDeliveryTargetId}
          targets={targets}
          {...(existing ? { selfId: existing.id } : {})}
          defaultLabel={t('storage.defaultDelivery')}
        />

        {!isEdit && (
          <Label className="flex items-center gap-2 text-xs text-slate-700">
            <Checkbox checked={form.orgWide} onCheckedChange={(v) => set('orgWide', v)} />
            {t('agentCfg.orgWide')}
          </Label>
        )}
      </div>
    </Modal>
  );
}
