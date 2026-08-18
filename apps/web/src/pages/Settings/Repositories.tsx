import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { t, useT, type MessageKey } from '../../lib/i18n';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { CardSkeleton, EmptyState, ErrorState } from '../../components/states';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import type { RepositoryRow } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field, Notice } from './primitives';
import { DeliveryTargetPicker } from './StorageTargets';
import { Label } from '@/components/ui/label';

/**
 * 代码仓库登记 —— 工作区来源的一种。
 *
 * ★★ 从「Agent 配置」里搬出来的。它此前是那一页的第三个标签页，而那个位置
 *   说错了归属：仓库不是某个 Agent 的属性，是**项目（或组织）级的资源登记**，
 *   一个 monorepo 被五个 Agent 引用是常态。存储目标先一步搬走了，
 *   仓库留在原地就成了「同一条理由只执行了一半」——
 *   两类工作区来源隔着一层标签页，而它们回答的是同一个问题：
 *   Agent 的活儿从哪来、产出去哪。
 *
 * ★ 与存储目标共处一页但**各自一张表单**：两类的字段完全不重叠
 *   （默认分支 / 分支前缀 / 主机密钥 vs bucket / 寻址风格 / 根路径），
 *   合成一张表单，不适用的那一半只能灰掉当占位符 —— 而占位符会被当成
 *   真实配置（「默认分支：main」出现在一个 S3 bucket 上）。
 *
 * Repositories are a project-level resource registry, not a property of any
 * one agent — so they live next to storage targets on the workspace-sources
 * page. Same page, separate forms: the two kinds share almost no fields, and
 * greyed-out placeholders read as real configuration.
 */
export function RepositoriesSection({ projectId }: { projectId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RepositoryRow | null>(null);

  const q = useQuery({
    queryKey: qk.repositories(projectId),
    queryFn: () => api.repositories(projectId),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteRepository(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.repositories(projectId) }),
  });

  if (q.isLoading) return <CardSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data!;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-xs text-slate-500">
          {t('agentCfg.repo.refNote')}
        </p>
        <Button variant="neutral" size="sm"
          onClick={() => setCreating(true)}
          className="ml-auto">
          {t('agentCfg.repo.registerButton')}
        </Button>
      </div>

      {/* ★ git 环境问题在这一页说清楚，而不是等第一次派发才炸 */}
      {!data.gitAvailable && (
        <Notice tone="error">
          {t('agentCfg.repo.gitProblem', { problem: data.gitProblem ?? '' })}
        </Notice>
      )}
      {/* ★ 同理：少装 openssh-client 的话，ssh 形态的仓库一个都用不了 */}
      {!data.sshAvailable && data.repositories.some((r) => r.authKind === 'ssh_key') && (
        <Notice tone="error">{data.sshProblem}</Notice>
      )}

      {data.repositories.length === 0 ? (
        <EmptyState
          icon="📦"
          message={t('agentCfg.repo.empty')}
          hint={t('agentCfg.repo.emptyHint')}
          action={{ label: t('agentCfg.repo.register'), onClick: () => setCreating(true) }}
        />
      ) : (
        <div className="space-y-2">
          {data.repositories.map((r) => (
            <RepositoryCard
              key={r.id}
              repo={r}
              onDelete={() => remove.mutate(r.id)}
              onEdit={() => setEditing(r)}
              error={remove.error}
            />
          ))}
        </div>
      )}

      {(creating || editing) && (
        <RepositoryForm
          projectId={projectId}
          existing={editing}
          encryptsInline={data.encryptsInlineSecrets}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onDone={() => {
            setCreating(false);
            setEditing(null);
            void qc.invalidateQueries({ queryKey: qk.repositories(projectId) });
          }}
        />
      )}
    </div>
  );
}

/**
 * 表单占位符跟着 git 地址变。
 *
 * ★ 与服务端的 resolveAuthUsername 是同一套判据，但这里只用来**提示**，
 *   真正生效的是服务端算的那份（回显在卡片上）。前端算错顶多提示不准，
 *   不会让认证行为不一致。
 */
function guessedAuthUsername(remoteUrl: string): string {
  const u = remoteUrl.toLowerCase();
  if (u.includes('github.com')) return 'x-access-token（GitHub）';
  if (u.includes('gitlab.com')) return 'oauth2（GitLab）';
  if (u.includes('bitbucket.org')) return 'x-token-auth（Bitbucket）';
  if (u.trim()) return t('agentCfg.repo.unknownHost');
  return 'x-access-token';
}

/**
 * 用户名来源 → 词条键 / Auth username source → message key.
 *
 * ★ 模块级常量取不到 hook，存译文的话切语言不重算 —— 存键，渲染处 t()。
 */
const AUTH_SOURCE_KEYS: Record<string, MessageKey> = {
  explicit: 'agentCfg.repo.authManual',
  host: 'agentCfg.repo.authGuessed',
  default: 'agentCfg.repo.authFallback',
};

export function RepositoryCard({
  repo,
  onDelete,
  onEdit,
  error,
}: {
  repo: RepositoryRow;
  onDelete: () => void;
  onEdit: () => void;
  error: unknown;
}) {
  const t = useT();
  const probe = useMutation({ mutationFn: () => api.probeRepository(repo.id) });
  const result = probe.data;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-800">
          {repo.ref}
        </code>
        <span className="text-sm text-slate-900">{repo.name}</span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
          {repo.scope === 'project' ? t('agentCfg.repo.scopeProject') : t('agentCfg.repo.scopeOrg')}
        </span>
        <div className="ml-auto flex gap-1.5">
          {/*
            ★ 「测试连接」是这张卡片上最该有的按钮。
              没有它，验证凭证的唯一办法是派一个任务，然后看它以
              「准备工作区失败：… 401」告终 —— 那条报错分不清是
              token 过期、scope 不够，还是用户名占位不对。
          */}
          <Button variant="outline" size="xs"
            onClick={() => probe.mutate()}
            disabled={probe.isPending}>
            {probe.isPending ? t('agentCfg.repo.testing') : t('agentCfg.repo.test')}
          </Button>
          <Button variant="outline" size="xs"
            onClick={onEdit}>
            {t('common.edit')}
          </Button>
          <Button variant="outline" size="xs"
            onClick={onDelete}
            className="text-rose-600 hover:bg-rose-50">
            {t('common.delete')}
          </Button>
        </div>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-600 sm:grid-cols-4">
        <Field label={t('agentCfg.repo.remote')}>{repo.remoteUrl}</Field>
        <Field label={t('agentCfg.repo.defaultBranch')}>{repo.defaultBranch}</Field>
        <Field label={t('agentCfg.repo.branchPrefix')}>{repo.branchPrefix}</Field>
        <Field label={t('agentCfg.field.credential')}>
          {repo.credentialHint ?? <span className="text-slate-400">{t('agentCfg.notConfigured')}</span>}
        </Field>
        {/*
          ★ 两种认证形态各显示各的那一项。
            token 这边最容易错的是用户名占位（错了就是 401，而 401 的报错
            不指向它 —— 自建 GitLab 踩的就是这个坑）；ssh 这边最容易被忽略
            的是主机公钥有没有固定 —— 没固定的话 TOFU 等于没有校验。
        */}
        {repo.authKind === 'token' ? (
          <Field label={t('agentCfg.repo.authUsername')}>
            <span className={repo.authUsernameSource === 'default' ? 'text-amber-700' : ''}>
              {repo.authUsername}
            </span>
            <span className="ml-1 text-slate-400">
              （
              {AUTH_SOURCE_KEYS[repo.authUsernameSource]
                ? t(AUTH_SOURCE_KEYS[repo.authUsernameSource]!)
                : repo.authUsernameSource}
              {repo.authProvider ? ` · ${repo.authProvider}` : ''}）
            </span>
          </Field>
        ) : (
          <Field label={t('agentCfg.repo.hostKey')}>
            {repo.sshHostKeyPinned ? (
              <span className="text-emerald-700">
                {t('agentCfg.repo.pinned', {
                  hosts: repo.sshHosts.length > 0 ? `（${repo.sshHosts.join('、')}）` : '',
                })}
              </span>
            ) : (
              <span className="text-amber-700">{t('agentCfg.repo.hostKeyUnpinned')}</span>
            )}
          </Field>
        )}
        <Field label={t('agentCfg.repo.qualityCheck')}>
          {repo.checkCommand ? (
            <code className="text-slate-800">{repo.checkCommand}</code>
          ) : (
            <span className="text-amber-700">{t('agentCfg.notConfigured')}</span>
          )}
        </Field>
      </dl>

      {repo.warnings.map((w) => (
        <p key={w} className="mt-2 text-[11px] text-amber-700">
          ⚠ {w}
        </p>
      ))}
      {repo.credentialProblem && (
        <p className="mt-1 text-[11px] text-rose-600">⚠ {repo.credentialProblem}</p>
      )}

      {result && (
        <p
          className={clsx(
            'mt-2 whitespace-pre-wrap rounded px-2 py-1 text-[11px]',
            result.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-700',
          )}
        >
          {result.ok ? '✓ ' : '✗ '}
          {result.message}
        </p>
      )}
      {probe.error instanceof ApiError && (
        <p className="mt-2 text-[11px] text-rose-600">{probe.error.message}</p>
      )}
      {error instanceof ApiError && <p className="mt-2 text-[11px] text-rose-600">{error.message}</p>}
    </div>
  );
}

export function RepositoryForm({
  projectId,
  existing,
  encryptsInline,
  onClose,
  onDone,
}: {
  projectId: string;
  /** 传了就是编辑，标识与远端不可改 */
  existing?: RepositoryRow | null;
  /** 直接粘贴的凭证是不是密文入库。两种都能存，只影响提示语 */
  encryptsInline: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const isEdit = Boolean(existing);
  const [form, setForm] = useState({
    ref: existing?.ref ?? '',
    name: existing?.name ?? '',
    remoteUrl: existing?.remoteUrl ?? '',
    defaultBranch: existing?.defaultBranch ?? 'main',
    branchPrefix: existing?.branchPrefix ?? 'apos/',
    // ★ 只回填手填过的那份。推断出来的值回填进去会把它「钉死」成显式值，
    //   之后换了域名也不会跟着变
    authUsername: existing?.authUsernameSource === 'explicit' ? existing.authUsername : '',
    checkCommand: existing?.checkCommand ?? '',
    credential: '',
    sshKnownHosts: existing?.sshKnownHosts ?? '',
    orgWide: existing ? existing.scope === 'organization' : false,
  });
  const [deliveryTargetId, setDeliveryTargetId] = useState(existing?.deliveryTargetId ?? null);

  /**
   * ★ 候选来自「存储目标」那一页 —— 交货目标只能是登记过的东西，
   *   因为投递要用凭证，而凭证只以引用存在登记表里。
   */
  const storage = useQuery({
    queryKey: qk.storageTargets(projectId),
    queryFn: () => api.storageTargets(projectId),
  });

  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  /**
   * ★ 两种认证形态的字段不重叠，同时摆出来只会让人填错栏 ——
   *   往 ssh 仓库里填 token、往 https 仓库里贴私钥都是真实发生过的错误。
   *   判据和服务端的 isHttpRemote 一致；这里只决定显示什么，
   *   真正生效的判定在服务端。
   */
  const isSsh = !/^https?:\/\//i.test((isEdit ? existing!.remoteUrl : form.remoteUrl).trim());

  const create = useMutation({
    mutationFn: () =>
      isEdit
        ? api.updateRepository(existing!.id, {
            name: form.name,
            defaultBranch: form.defaultBranch,
            branchPrefix: form.branchPrefix,
            authUsername: form.authUsername.trim() || null,
            checkCommand: form.checkCommand.trim() || null,
            deliveryTargetId,
            // null = 清空（下次连接重新学习），这是服务器换了密钥时的出路
            sshKnownHosts: form.sshKnownHosts.trim() || null,
            // 留空 = 不改凭证（避免编辑别的字段时把凭证清掉）
            ...(form.credential.trim() ? { credential: form.credential.trim() } : {}),
          })
        : api.createRepository({
        ref: form.ref,
        name: form.name,
        remoteUrl: form.remoteUrl,
        defaultBranch: form.defaultBranch,
        branchPrefix: form.branchPrefix,
        // ★ 这两个此前一直躺在表单 state 里没被提交 ——
        //   checkCommand 因此只能改数据库才配得上，而它是
        //   reviewing 阶段唯一的真实测试数据源
        authUsername: form.authUsername.trim() || null,
        checkCommand: form.checkCommand.trim() || null,
            deliveryTargetId,
            sshKnownHosts: form.sshKnownHosts.trim() || null,
            credential: form.credential.trim() || null,
            projectId: form.orgWide ? null : projectId,
          }),
    onSuccess: onDone,
  });

  return (
    <Modal
      onClose={onClose}
      title={t('agentCfg.repo.sectionTitle')}
      width="lg"
      footer={
        <div className="space-y-2">
          {create.error instanceof ApiError && (
            <p className="text-xs text-rose-600">{create.error.message}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="neutral" size="sm"
              disabled={!form.ref.trim() || !form.remoteUrl.trim() || create.isPending}
              onClick={() => create.mutate()}>
              {create.isPending ? t('agentCfg.repo.registering') : t('agentCfg.repo.submit')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">
          {isEdit ? t('agentCfg.repo.editing', { name: existing!.name }) : t('agentCfg.repo.formTitle')}
        </h2>
        <Label className="block">
          <span className="text-xs font-medium text-slate-700">{t('agentCfg.repo.ref')}</span>
          <Input
            value={form.ref}
            disabled={isEdit}
            onChange={(e) => set('ref', e.target.value)}
            placeholder="order-service"
            className="mt-1 disabled:bg-slate-50 disabled:text-slate-500" />
          <p className="mt-1 text-[11px] text-slate-500">
            {t('agentCfg.repo.refHint')}
          </p>
        </Label>

        <Label className="block">
          <span className="text-xs font-medium text-slate-700">{t('agentCfg.repo.displayName')}</span>
          <Input
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            className="mt-1" />
        </Label>

        <Label className="block">
          <span className="text-xs font-medium text-slate-700">{t('agentCfg.repo.gitUrl')}</span>
          <Input
            value={form.remoteUrl}
            disabled={isEdit}
            onChange={(e) => set('remoteUrl', e.target.value)}
            placeholder="https://github.com/acme/order-service.git"
            className="mt-1 disabled:bg-slate-50 disabled:text-slate-500" />
          <p className="mt-1 text-[11px] text-slate-500">
            {t('agentCfg.repo.authSwitchHint')}
          </p>
        </Label>

        <div className="grid grid-cols-2 gap-2">
          <Label className="block">
            <span className="text-xs font-medium text-slate-700">{t('agentCfg.repo.defaultBranch')}</span>
            <Input
              value={form.defaultBranch}
              onChange={(e) => set('defaultBranch', e.target.value)}
              className="mt-1" />
          </Label>
          <Label className="block">
            <span className="text-xs font-medium text-slate-700">{t('agentCfg.repo.branchPrefix')}</span>
            <Input
              value={form.branchPrefix}
              onChange={(e) => set('branchPrefix', e.target.value)}
              className="mt-1" />
          </Label>
        </div>

        {!isSsh && (
          <Label className="block">
            <span className="text-xs font-medium text-slate-700">
              {t('agentCfg.repo.authUsernamePlaceholder')}
              <span className="ml-1 font-normal text-slate-400">{t('login.field.optional')}</span>
            </span>
            <Input
              value={form.authUsername}
              onChange={(e) => set('authUsername', e.target.value)}
              placeholder={guessedAuthUsername(form.remoteUrl)}
              className="mt-1" />
            {/*
              ★ 这一项填错的表现是 401，而 401 的报错里没有任何东西指向它。
                留空能按 github.com / gitlab.com 推断出来，但**自建** GitLab
                装在 git.acme.com 上推不出来 —— 那正是最常见的部署形态。
            */}
            <p className="mt-1 text-[11px] text-slate-500">
              {t('agentCfg.repo.authUsernameHint')}
              <span className="text-amber-700">{t('agentCfg.repo.gitlabNote')}</span>
            </p>
          </Label>
        )}

        {isSsh && (
          <Label className="block">
            <span className="text-xs font-medium text-slate-700">
              {t('agentCfg.repo.hostPublicKey')}
              <span className="ml-1 font-normal text-slate-400">{t('agentCfg.repo.knownHostsHint')}</span>
            </span>
            <Textarea
              value={form.sshKnownHosts}
              onChange={(e) => set('sshKnownHosts', e.target.value)}
              rows={2}
              placeholder="github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA…"
              className="mt-1 font-mono"
            />
            {/*
              ★ 留空不等于不校验 —— 首次连接会 TOFU 学到并自动固定。
                但那一次窗口是真实存在的，所以要给出关掉它的办法。
              ★ 这一栏**不加密**，因为主机公钥本来就是公开比对的那一份。
                必须说清楚，否则会有人把私钥贴进来。
            */}
            <p className="mt-1 text-[11px] text-slate-500">
              {t('agentCfg.repo.keyscanHint')}
              {t('agentCfg.repo.strictAfterFirst')}
              <span className="text-amber-700">{t('agentCfg.repo.publicInfo')}</span>
            </p>
          </Label>
        )}

        <Label className="block">
          <span className="text-xs font-medium text-slate-700">
            {t('agentCfg.repo.checkCommand')}
            <span className="ml-1 font-normal text-slate-400">{t('login.field.optional')}</span>
          </span>
          <Input
            value={form.checkCommand}
            onChange={(e) => set('checkCommand', e.target.value)}
            placeholder="pnpm test"
            className="mt-1" />
          {/*
            ★ 不填不是「少个功能」，是 reviewing 阶段的门禁没有数据可依据。
          */}
          <p className="mt-1 text-[11px] text-slate-500">
            {t('agentCfg.repo.checkHint')}
          </p>
        </Label>

        <DeliveryTargetPicker
          value={deliveryTargetId}
          onChange={setDeliveryTargetId}
          targets={storage.data?.storageTargets ?? []}
          defaultLabel={t('agentCfg.repo.defaultDelivery')}
        />

        <Label className="block">
          <span className="text-xs font-medium text-slate-700">
            {isSsh ? t('agentCfg.repo.sshKey') : t('agentCfg.repo.accessToken')}
          </span>
          {/*
            ★★ 私钥必须用 textarea：`<input>` 会把粘贴内容里的换行吃掉，
              而 PEM 是多行的 —— 单行输入框根本装不下一把 key，
              表现是保存后提示「格式不正确」，而用户明明整段复制了。
          */}
          {isSsh ? (
            <Textarea
              value={form.credential}
              onChange={(e) => set('credential', e.target.value)}
              rows={4}
              placeholder={
                t('agentCfg.repo.sshPlaceholder')
              }
              className="mt-1 font-mono"
            />
          ) : (
            <Input
              value={form.credential}
              onChange={(e) => set('credential', e.target.value)}
              type="password"
              placeholder={t('agentCfg.repo.tokenPlaceholder')}
              className="mt-1" />
          )}
          <p className="mt-1 text-[11px] text-slate-500">
            {isSsh ? (
              <>
                {t('agentCfg.repo.sshHint')}{' '}
                {encryptsInline ? t('agentCfg.repo.encrypted') : t('agentCfg.repo.plaintext')}
                {t('agentCfg.repo.neverEchoed')}{' '}
                <span className="text-amber-700">{t('agentCfg.repo.noPassphrase')}</span>{' '}
                {t('agentCfg.repo.sshFallback')}
              </>
            ) : (
              t('agentCfg.repo.credentialRequired')
            )}
          </p>
        </Label>

        <Label className="flex items-center gap-2 text-xs text-slate-700">
          <Checkbox checked={form.orgWide} onCheckedChange={(v) => set('orgWide', v)} />
          {t('agentCfg.orgWide')}
        </Label>
      </div>
    </Modal>
  );
}

