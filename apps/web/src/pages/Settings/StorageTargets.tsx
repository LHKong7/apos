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
 * Storage targets — the non-Git workspace sources: object buckets and host
 * directories / 存储目标。
 *
 * ★★ Only **components** are left in this file; the page lives in
 *   WorkspaceSources.tsx.
 *
 *   Storage targets were once the fourth tab under "Agent config", then a page of
 *   their own, and are now merged with repositories into "workspace sources" —
 *   neither kind is a property of some agent, both are project-level (or org-level)
 *   resource registries answering the same question: where does the agent's work come
 *   from and where does its output go.
 *
 * ★ Same page as repositories but **separate forms**: the fields of the two kinds do
 *   not overlap at all (bucket / addressing style vs. default branch / branch prefix).
 *   Mixed into one form, the inapplicable half can only render as a grayed-out
 *   placeholder — and a placeholder gets read as real configuration.
 *
 * ★★ 这个文件里只剩组件，页面在 WorkspaceSources.tsx；与代码仓库同处一页但各自
 *   一张表单 —— 两类字段完全不重叠，灰掉的占位符会被当成真实配置。
 */


/** Storage target kind → message key; module-level constants store keys only / 存储目标类型 → 词条键 */
export const TARGET_KIND_KEYS: Record<StorageTargetRow['kind'], MessageKey> = {
  object_storage: 'storage.objectStorage',
  local: 'storage.localDir',
};

/**
 * The "where does output get delivered" picker — shared by the storage-target form and
 * the repository form / 「产出交货到哪」选择器。
 *
 * ★ Moved here from AgentConfig and exported: what it talks about is storage targets
 *   (candidates, writability, addressing) and it merely **happens** to be used by the
 *   repository form too. Left behind, this page would have to import that one.
 *
 * ★★ Only **writable** storage targets are listed. A read-only target is silently
 *   skipped at delivery time, so offering it here invites the user to configure a
 *   value that will never take effect — and that failure mode (task succeeded, the
 *   artifacts page has a record, the target holds nothing) is extremely hard to reason
 *   your way to.
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
  /** Passed while editing a storage target, to drop it from its own candidate list */
  selfId?: string;
  /** Describes what happens when nothing is selected */
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
          ★ Writability has to be visible at a glance on the card: a read-only mount is
            silently skipped at delivery time, and "registered read-only yet expected to
            receive output" shows up as "the task succeeded but there is nothing in it".
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
 * How a server error is worded / 服务端错误的说法。
 *
 * ★ When the server sends `{ code, params }` the wording comes from the catalog; only
 *   when the code is unknown does it fall back to the server's Chinese sentence.
 *   Rendering `error.message` directly costs this: a validation error meant to tell the
 *   user how to fix their input shows up as a full Chinese sentence in the English UI.
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
  /** Passing one means edit mode; the ref and the kind cannot be changed */
  existing?: StorageTargetRow | null;
  /**
   * The initial kind when creating / 新建时的初始类型。
   *
   * ★ The workspace-sources page already asked for the kind **before** opening the form
   *   (KindPicker), so carrying it in spares the user a second pick — and "I chose a
   *   kind, then the form's kind snapped back to the default" reads as the previous
   *   step not having taken effect. Ignored while editing: the kind cannot be changed.
   */
  initialKind?: StorageTargetRow['kind'];
  /** Candidates for the delivery target */
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
            // Empty = leave the credential alone (so editing other fields cannot wipe it)
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
          ★ The kind is immutable once registered: the required columns of the two kinds
            do not overlap, so a half-migrated row is rejected outright by a database
            constraint whose error names the constraint, not the field. To switch, delete
            and re-create — and that path also runs the "is any agent grant pointing at
            it" check.
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
              ★★ Getting the addressing style backwards shows up as a DNS resolution
                failure, and nothing in that error points at "addressing style". So
                path-style is on by default, and this spot spells out when to turn it off.
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
