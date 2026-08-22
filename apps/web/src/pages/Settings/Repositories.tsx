import { useState } from 'react';
import { joinList } from '@/lib/format';
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
 * Repository registration — one kind of workspace source / 代码仓库登记。
 *
 * ★★ Moved out of "Agent config". It used to be the third tab there, and that spot
 *   asserted the wrong ownership: a repository is not a property of some agent, it is
 *   a **project-level (or org-level) resource registry**, and one monorepo referenced
 *   by five agents is the normal case. Storage targets moved out first, so leaving
 *   repositories behind executed only half of the same argument — two kinds of
 *   workspace source separated by a tab, both answering the same question: where does
 *   the agent's work come from and where does its output go.
 *
 * ★ They share a page with storage targets but keep **separate forms**: the fields of
 *   the two kinds do not overlap at all (default branch / branch prefix / host key vs.
 *   bucket / addressing style / root path). Fused into one form, the inapplicable half
 *   can only be grayed out as a placeholder — and placeholders get read as real
 *   configuration ("default branch: main" showing up on an S3 bucket).
 *
 * ★★ 仓库是项目级的资源登记，不是某个 Agent 的属性，所以它和存储目标同处
 *   「工作区来源」一页；同页但各自一张表单 —— 两类字段不重叠，灰掉的占位符
 *   会被当成真实配置。
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

      {/* ★ git environment problems are stated on this page, not blown up on first dispatch */}
      {!data.gitAvailable && (
        <Notice tone="error">
          {t('agentCfg.repo.gitProblem', { problem: data.gitProblem ?? '' })}
        </Notice>
      )}
      {/* ★ Likewise: without openssh-client installed, not one ssh-style repository works */}
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
 * Form placeholders follow the git URL / 表单占位符跟着 git 地址变。
 *
 * ★ Same rules as the server's resolveAuthUsername, but here they only produce a
 *   **hint**. What actually takes effect is the server's computation (echoed back on
 *   the card). Getting it wrong on the client makes the hint inaccurate at worst; it
 *   cannot make authentication behave inconsistently.
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
 * Auth username source → message key / 用户名来源 → 词条键。
 *
 * ★ A module-level constant cannot reach a hook, and a translated string stored here
 *   is not recomputed when the language changes — so store the key and call t() at
 *   render time.
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
            ★ "Test connection" is the button this card most needs.
              Without it, the only way to verify a credential is to dispatch a task and
              watch it end in "failed to prepare workspace: … 401" — and that error
              cannot tell an expired token from insufficient scope from a wrong
              username placeholder.
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
          ★ Each auth style shows only its own field.
            On the token side the easiest thing to get wrong is the username
            placeholder (wrong means 401, and nothing in a 401 points at it — this is
            exactly the trap self-hosted GitLab falls into); on the ssh side the
            easiest thing to overlook is whether the host key is pinned — unpinned,
            TOFU amounts to no verification at all.
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
                  hosts: repo.sshHosts.length > 0 ? `（${joinList(repo.sshHosts)}）` : '',
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
  /** Passing one means edit mode; the ref and the remote cannot be changed */
  existing?: RepositoryRow | null;
  /** Whether a pasted credential is stored encrypted. Both work; it only changes the hint */
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
    // ★ Only prefill a value the user typed. Prefilling an inferred one pins it as an
    //   explicit value, so it stops following a later change of host
    authUsername: existing?.authUsernameSource === 'explicit' ? existing.authUsername : '',
    checkCommand: existing?.checkCommand ?? '',
    credential: '',
    sshKnownHosts: existing?.sshKnownHosts ?? '',
    orgWide: existing ? existing.scope === 'organization' : false,
  });
  const [deliveryTargetId, setDeliveryTargetId] = useState(existing?.deliveryTargetId ?? null);

  /**
   * ★ The candidates come from the storage-targets page — a delivery target can only
   *   be something already registered, because delivery needs a credential and
   *   credentials exist only as references in the registry.
   */
  const storage = useQuery({
    queryKey: qk.storageTargets(projectId),
    queryFn: () => api.storageTargets(projectId),
  });

  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  /**
   * ★ The fields of the two auth styles do not overlap, and showing both at once only
   *   gets people to fill in the wrong box — pasting a token into an ssh repository
   *   and a private key into an https one have both really happened. The rule matches
   *   the server's isHttpRemote; here it only decides what is displayed, the binding
   *   decision is made on the server.
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
            // null = clear it (relearn on next connect); the way out when the server rotates its key
            sshKnownHosts: form.sshKnownHosts.trim() || null,
            // Empty = leave the credential alone (so editing other fields cannot wipe it)
            ...(form.credential.trim() ? { credential: form.credential.trim() } : {}),
          })
        : api.createRepository({
        ref: form.ref,
        name: form.name,
        remoteUrl: form.remoteUrl,
        defaultBranch: form.defaultBranch,
        branchPrefix: form.branchPrefix,
        // ★ These two sat in form state without ever being submitted — which meant
        //   checkCommand could only be configured by editing the database, and it is the
        //   sole source of real test data in the reviewing stage
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
              ★ Getting this field wrong shows up as a 401, and nothing in a 401 points
                at it. Left blank it can be inferred for github.com / gitlab.com, but a
                **self-hosted** GitLab sitting on git.acme.com cannot be inferred — and
                that is the most common deployment shape there is.
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
              ★ Blank does not mean unverified — the first connection learns the key via
                TOFU and pins it automatically. But that one window is genuinely open,
                so there has to be a way to close it.
              ★ This field is **not encrypted**, because a host public key is the part
                meant to be compared in the open. Say so plainly, or someone will paste
                a private key in here.
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
            ★ Leaving it empty is not "one feature missing" — it leaves the reviewing
              stage's gate with no data to judge on.
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
            ★★ A private key must use a textarea: `<input>` swallows the newlines in
              pasted content, and PEM is multi-line — a single-line box simply cannot
              hold a key. The symptom is a "malformed" error after saving even though
              the user copied the whole thing.
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

