import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT, type MessageKey } from '../../lib/i18n';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { CardSkeleton, EmptyState, ErrorState } from '../../components/states';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import { useAuthStore } from '../../stores/auth';
import type { RepositoryRow, StorageTargetRow } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Notice } from './primitives';
import { RepositoryCard, RepositoryForm } from './Repositories';
import { StorageTargetCard, StorageTargetForm } from './StorageTargets';

/**
 * Workspace sources — where the agent's work comes from and where its output goes /
 * 工作区来源。
 *
 * ★★ **One list**, not two separate blocks for "repositories" and "storage targets".
 *
 *   The two used to live apart: repositories were the third tab of "Agent config",
 *   storage targets had their own slot in the nav. The reasons for splitting them
 *   were data-layer reasons — the two tables share almost no columns, and delivery
 *   means different things (pushing a branch vs. syncing objects, where the latter
 *   deletes remote keys). But those reasons are about **tables and forms**, not about
 *   **lists and navigation**: standing on this page a user is asking "where do this
 *   project's code and data live", and one question should not be answered in two
 *   places.
 *
 *   Hence: one list, one registration entry point; clicking "register" asks for the
 *   kind first, then shows that kind's own form. Underneath there are still two
 *   tables and two permissions (repository.manage / storage_target.manage) — what was
 *   merged is the entry point, not the model.
 *
 * ★ Registering is not authorizing. Which agent may use which source is still
 *   configured in "Agent config" (resourceScopes' repo / dataset), and the page
 *   footer points back there explicitly. The one exception is that **a project-level
 *   repository is read-only by default for agents in that project** (domain's
 *   effectiveResourceScopes) — a project usually has exactly one repository, and
 *   granting it agent by agent buys no security whatsoever. `write` still has to be
 *   granted explicitly.
 *
 * ★★ 一张列表，不是「代码仓库」和「存储目标」两个板块。底下仍然是两张表、两条权限
 *   （repository.manage / storage_target.manage）—— 合并的是入口，不是模型。
 *
 * ★ 登记 ≠ 授权。哪个 Agent 能用哪个来源仍在「Agent 配置」里配，页尾显式指回去；
 *   唯一的例外是项目级仓库对项目内 Agent 默认只读。
 */
export function WorkspaceSourcesPage() {
  const t = useT();
  const { projectId } = useParams<{ projectId: string }>();
  const userId = useAuthStore((s) => s.userId);

  if (!projectId || !userId) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">{t('ws.title')}</h1>
          <Link
            to={`/projects/${projectId}`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            {t('agents.backToOverview')}
          </Link>
        </div>
        <p className="mt-1 text-[11px] text-slate-500">{t('ws.subtitle')}</p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <WorkspaceSourcesSection projectId={projectId} />
      </div>
    </div>
  );
}

/** The three source kinds you can register / 登记时可选的三类来源 */
type SourceKind = 'git' | 'object_storage' | 'local';

/**
 * Kind → message key. Module-level constants store keys, never translated strings:
 * they cannot reach a hook, and they are not recomputed when the language changes.
 */
const KIND_KEYS: Record<SourceKind, { label: MessageKey; hint: MessageKey }> = {
  git: { label: 'ws.kindGit', hint: 'ws.kindGitHint' },
  object_storage: { label: 'ws.kindObject', hint: 'ws.kindObjectHint' },
  local: { label: 'ws.kindLocal', hint: 'ws.kindLocalHint' },
};

/** One row of the list: both source kinds are flattened into the same shape here */
type SourceRow =
  | { kind: 'git'; ref: string; repo: RepositoryRow }
  | { kind: 'object_storage' | 'local'; ref: string; target: StorageTargetRow };

function WorkspaceSourcesSection({ projectId }: { projectId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState<SourceKind | null>(null);
  const [editingRepo, setEditingRepo] = useState<RepositoryRow | null>(null);
  const [editingTarget, setEditingTarget] = useState<StorageTargetRow | null>(null);

  const repoQ = useQuery({
    queryKey: qk.repositories(projectId),
    queryFn: () => api.repositories(projectId),
  });
  const storeQ = useQuery({
    queryKey: qk.storageTargets(projectId),
    queryFn: () => api.storageTargets(projectId),
  });

  const removeRepo = useMutation({
    mutationFn: (id: string) => api.deleteRepository(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.repositories(projectId) }),
  });
  const removeTarget = useMutation({
    mutationFn: (id: string) => api.deleteStorageTarget(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.storageTargets(projectId) }),
  });

  if (repoQ.isLoading || storeQ.isLoading) return <CardSkeleton />;
  /**
   * ★ If either query fails the whole page errors out, rather than rendering half a
   *   list. Half a list looks exactly like "nothing of the other kind is registered"
   *   — which is precisely what sends the user off to register a duplicate.
   */
  const failed = repoQ.error ?? storeQ.error;
  if (failed) {
    return (
      <ErrorState
        error={failed}
        onRetry={() => {
          void repoQ.refetch();
          void storeQ.refetch();
        }}
      />
    );
  }

  const repoData = repoQ.data!;
  const storeData = storeQ.data!;

  /**
   * ★ Sorted by ref rather than grouped by kind — grouping renders as two blocks all
   *   over again, and ref is the key the user actually cites when granting agent
   *   access.
   */
  const rows: SourceRow[] = [
    ...repoData.repositories.map((repo): SourceRow => ({ kind: 'git', ref: repo.ref, repo })),
    ...storeData.storageTargets.map(
      (target): SourceRow => ({ kind: target.kind, ref: target.ref, target }),
    ),
  ].sort((a, b) => a.ref.localeCompare(b.ref));

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: qk.repositories(projectId) });
    void qc.invalidateQueries({ queryKey: qk.storageTargets(projectId) });
  };
  const closeForms = () => {
    setCreating(null);
    setEditingRepo(null);
    setEditingTarget(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-xs text-slate-500">{t('ws.intro')}</p>
        <Button variant="neutral" size="sm" onClick={() => setPicking(true)} className="ml-auto">
          {t('ws.register')}
        </Button>
      </div>

      {/* ★ Environment problems are stated on this page, not blown up on first dispatch */}
      {!repoData.gitAvailable && (
        <Notice tone="error">
          {t('agentCfg.repo.gitProblem', { problem: repoData.gitProblem ?? '' })}
        </Notice>
      )}
      {!repoData.sshAvailable && repoData.repositories.some((r) => r.authKind === 'ssh_key') && (
        <Notice tone="error">{repoData.sshProblem}</Notice>
      )}

      {/*
        ★★ The allowlist only governs the host-directory kind, but it is shown at all
          times. It is a **deployment environment** variable
          (APOS_LOCAL_MOUNT_ROOTS) that an admin can neither see nor change from the
          UI, yet it alone decides whether a local registration passes the gate.
          Hidden, a gated registration looks identical to a working one until the
          first dispatch reports "outside the permitted mount roots".
      */}
      <Notice tone={storeData.localMountRestricted ? 'info' : 'warning'}>
        {storeData.localMountRestricted ? (
          <>
            {t('storage.mountRoots')}
            {/*
              ★ Multiple roots need a separator between them. With only mx-1 the two
                code blocks are parted by a sliver of whitespace and read as one long
                wrapped path; and since the explanatory sentence opens with a period,
                the trailing one gets pushed by the margin into a lone floating dot.
            */}
            {storeData.localMountRoots.map((r, i) => (
              <span key={r}>
                {i > 0 && <span className="text-slate-400">, </span>}
                <code className="rounded bg-white px-1 py-0.5">{r}</code>
              </span>
            ))}
            {' '}
            {t('storage.mountRootsNote')}
          </>
        ) : (
          <>{t('storage.noMountRoots')}</>
        )}
      </Notice>

      {rows.length === 0 ? (
        <EmptyState
          icon="🗂️"
          message={t('ws.empty')}
          hint={t('ws.emptyHint')}
          action={{ label: t('ws.registerShort'), onClick: () => setPicking(true) }}
        />
      ) : (
        <div className="space-y-2">
          {rows.map((row) =>
            row.kind === 'git' ? (
              <RepositoryCard
                key={row.repo.id}
                repo={row.repo}
                onDelete={() => removeRepo.mutate(row.repo.id)}
                onEdit={() => setEditingRepo(row.repo)}
                error={removeRepo.error}
              />
            ) : (
              <StorageTargetCard
                key={row.target.id}
                target={row.target}
                onDelete={() => removeTarget.mutate(row.target.id)}
                onEdit={() => setEditingTarget(row.target)}
                error={removeTarget.error}
              />
            ),
          )}
        </div>
      )}

      {/*
        ★ Authorization lives on the Agent config page — registering a source does not
          make any agent able to see it. The one exception, a project-level
          repository's default read access, has to be spelled out too: left unsaid,
          "I configured nothing, how did it read that" is just as unanswerable.
      */}
      <p className="text-[11px] text-slate-500">
        {t('ws.grantHint')}{' '}
        <Link
          to={`/projects/${projectId}/settings/agents`}
          className="text-slate-600 underline hover:text-slate-900"
        >
          {t('nav.agentConfig')}
        </Link>
        {t('ws.grantHintDefault')}
      </p>

      {picking && (
        <KindPicker
          onPick={(kind) => {
            setPicking(false);
            setCreating(kind);
          }}
          onClose={() => setPicking(false)}
        />
      )}

      {(creating === 'git' || editingRepo) && (
        <RepositoryForm
          projectId={projectId}
          existing={editingRepo}
          encryptsInline={repoData.encryptsInlineSecrets}
          onClose={closeForms}
          onDone={() => {
            closeForms();
            invalidateAll();
          }}
        />
      )}

      {(creating === 'object_storage' || creating === 'local' || editingTarget) && (
        <StorageTargetForm
          projectId={projectId}
          existing={editingTarget}
          {...(creating && creating !== 'git' ? { initialKind: creating } : {})}
          targets={storeData.storageTargets}
          encryptsInline={storeData.encryptsInlineSecrets}
          onClose={closeForms}
          onDone={() => {
            closeForms();
            invalidateAll();
          }}
        />
      )}
    </div>
  );
}

/**
 * Pick the kind first, then fill in the form / 先选类型，再填表单。
 *
 * ★★ The kind must be asked **before** the form rather than being a dropdown inside
 *   it. The three kinds share almost no fields (remote URL / default branch vs.
 *   bucket / addressing style vs. host path), so switching kind inside one form makes
 *   half of what the user already typed vanish — and they will not read that as "not
 *   applicable", they will read it as having lost their input.
 */
function KindPicker({
  onPick,
  onClose,
}: {
  onPick: (kind: SourceKind) => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Modal title={t('ws.pickKind')} onClose={onClose}>
      <div className="space-y-2">
        {(Object.keys(KIND_KEYS) as SourceKind[]).map((kind) => (
          <Button variant="ghost"
            key={kind}
            onClick={() => onPick(kind)}
            className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent justify-start w-full rounded-lg border border-slate-200 p-3 text-left hover:border-slate-400 hover:bg-slate-50"
          >
            <div className="text-sm font-medium text-slate-900">{t(KIND_KEYS[kind].label)}</div>
            <div className="mt-0.5 text-[11px] text-slate-500">{t(KIND_KEYS[kind].hint)}</div>
          </Button>
        ))}
      </div>
    </Modal>
  );
}
