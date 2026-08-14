import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { t, useT, type MessageKey } from '../../lib/i18n';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { CardSkeleton, EmptyState, ErrorState } from '../../components/states';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import { useAuthStore } from '../../stores/auth';
import type { StorageTargetRow } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Field, Labeled, Notice, StatusDot } from './primitives';

/**
 * 存储目标 —— 非 Git 的工作区来源：对象存储桶 / 宿主机目录。
 *
 * ★★ 这是**独立一页**，不是 Agent 配置里的一个标签页。
 *
 *   它此前挂在「Agent 配置」下面，而那个位置说错了两件事：
 *
 *   1. 存储目标不属于任何一个 Agent。它是**项目级（或组织级）的资源登记**，
 *      与代码仓库同级 —— 一个 bucket 被三个 Agent 引用是常态，删掉它要看的是
 *      「有没有 Agent 授权指向它」，而不是某一个 Agent 的配置。放在 Agent 页
 *      底下，会让人以为换 Agent 要重配一遍。
 *   2. 找不到。要配一个数据集来源，路径是「Agent 配置 → 第四个标签」——
 *      而用户此刻想的是「我要挂一个数据目录」，脑子里没有 Agent。
 *      导航是功能的可见性：一个要点进别的页面才找得到的设置，
 *      对没读过文档的人等于不存在。
 *
 *   Storage targets are a project-level resource registry (sibling to code
 *   repositories), not a property of any single agent — so they get their own
 *   nav entry instead of living as the fourth tab under Agent settings, where
 *   nobody looking to mount a data directory would think to look.
 *
 * ★ 与「代码仓库」并列而不是合成一页：两类的字段完全不重叠
 *   （bucket / 寻址风格 vs 默认分支 / 分支前缀），混在一张表单里，
 *   不适用的那半边只能显示成灰掉的占位符 —— 而占位符会被当成真实配置。
 */
export function StorageTargetsPage() {
  const t = useT();
  const { projectId } = useParams<{ projectId: string }>();
  const userId = useAuthStore((s) => s.userId);

  if (!projectId || !userId) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">{t('storage.title')}</h1>
          <Link
            to={`/projects/${projectId}`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            {t('agents.backToOverview')}
          </Link>
        </div>
        <p className="mt-1 text-[11px] text-slate-500">{t('storage.subtitle')}</p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <StorageTargetsSection projectId={projectId} />
      </div>
    </div>
  );
}

function StorageTargetsSection({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<StorageTargetRow | null>(null);

  const q = useQuery({
    queryKey: qk.storageTargets(projectId),
    queryFn: () => api.storageTargets(projectId),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteStorageTarget(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.storageTargets(projectId) }),
  });

  if (q.isLoading) return <CardSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data!;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-xs text-slate-500">{t('storage.intro')}</p>
        <Button variant="neutral" size="sm" onClick={() => setCreating(true)} className="ml-auto">
          {t('storage.register')}
        </Button>
      </div>

      {/*
        ★★ 白名单必须在这一页显示出来。
          它是**部署环境**的变量（APOS_LOCAL_MOUNT_ROOTS），管理员在界面上
          改不动也看不到，而一条 local 登记过不过闸完全由它决定 ——
          不显示的话，被闸掉的登记在页面上和正常的一模一样，
          直到第一次派发才报「不在允许挂载的范围内」。
      */}
      <Notice tone={data.localMountRestricted ? 'info' : 'warning'}>
        {data.localMountRestricted ? (
          <>
            {t('storage.mountRoots')}
            {data.localMountRoots.map((r) => (
              <code key={r} className="mx-1 rounded bg-white px-1 py-0.5">
                {r}
              </code>
            ))}
            {t('storage.mountRootsNote')}
          </>
        ) : (
          <>{t('storage.noMountRoots')}</>
        )}
      </Notice>

      {data.storageTargets.length === 0 ? (
        <EmptyState
          icon="🗄️"
          message={t('storage.emptyMessage')}
          hint={t('storage.emptyHint')}
          action={{ label: t('storage.registerShort'), onClick: () => setCreating(true) }}
        />
      ) : (
        <div className="space-y-2">
          {data.storageTargets.map((target) => (
            <StorageTargetCard
              key={target.id}
              target={target}
              onDelete={() => remove.mutate(target.id)}
              onEdit={() => setEditing(target)}
              error={remove.error}
            />
          ))}
        </div>
      )}

      {/*
        ★ 授权在 Agent 配置那一页 —— 登记一个目标不等于哪个 Agent 看得见它。
          这条指路是这次拆分欠的：两页分开之后，「配完了为什么 Agent 还读不到」
          少了一个显而易见的答案。
      */}
      <p className="text-[11px] text-slate-500">
        {t('storage.grantHint')}{' '}
        <Link
          to={`/projects/${projectId}/settings/agents`}
          className="text-slate-600 underline hover:text-slate-900"
        >
          {t('nav.agentConfig')}
        </Link>
      </p>

      {(creating || editing) && (
        <StorageTargetForm
          projectId={projectId}
          existing={editing}
          targets={data.storageTargets}
          encryptsInline={data.encryptsInlineSecrets}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onDone={() => {
            setCreating(false);
            setEditing(null);
            void qc.invalidateQueries({ queryKey: qk.storageTargets(projectId) });
          }}
        />
      )}
    </div>
  );
}

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
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
      >
        <option value="">{t('agentCfg.delivery.default', { label: defaultLabel })}</option>
        {options.map((target) => (
          <option key={target.id} value={target.id}>
            {target.ref} · {t(TARGET_KIND_KEYS[target.kind])}
          </option>
        ))}
      </select>
      {options.length === 0 && (
        <p className="mt-1 text-[11px] text-slate-500">{t('agentCfg.noWritableTargets')}</p>
      )}
    </Labeled>
  );
}

function StorageTargetCard({
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
              {t('storage.samples', { samples: result.samples.slice(0, 5).join('、') })}
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

function StorageTargetForm({
  projectId,
  existing,
  targets,
  encryptsInline,
  onClose,
  onDone,
}: {
  projectId: string;
  /** 传了就是编辑；标识与类型不可改 */
  existing?: StorageTargetRow | null;
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
    kind: existing?.kind ?? ('object_storage' as StorageTargetRow['kind']),
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
            <p className="text-xs text-rose-600">{save.error.message}</p>
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
            <label className="flex items-start gap-2 text-xs text-slate-700">
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
            </label>

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

        <label className="flex items-start gap-2 text-xs text-slate-700">
          <Checkbox checked={form.writable} onCheckedChange={(v) => set('writable', v)} />
          <span>
            {t('agentCfg.writable')}
            <span className="mt-0.5 block text-[11px] text-slate-500">
              {t('storage.writableHint')}
            </span>
          </span>
        </label>

        <DeliveryTargetPicker
          value={deliveryTargetId}
          onChange={setDeliveryTargetId}
          targets={targets}
          {...(existing ? { selfId: existing.id } : {})}
          defaultLabel={t('storage.defaultDelivery')}
        />

        {!isEdit && (
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <Checkbox checked={form.orgWide} onCheckedChange={(v) => set('orgWide', v)} />
            {t('agentCfg.orgWide')}
          </label>
        )}
      </div>
    </Modal>
  );
}
