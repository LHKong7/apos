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
 * 工作区来源 —— Agent 的活儿从哪来、产出去哪。
 *
 * ★★ **一张列表**，不是「代码仓库」和「存储目标」两个板块。
 *
 *   这两类曾经分处两地：仓库是「Agent 配置」的第三个标签页，存储目标是
 *   导航里独立的一格。分处的理由是数据层的 —— 两张表的列几乎不重叠，
 *   交货语义也不同（推分支 vs 同步对象，后者会删远端 key）。但那些理由
 *   说的是**表和表单**，不是**列表和导航**：用户站在这一页上想的是
 *   「这个项目的代码和数据在哪」，一个问题不该分两个地方回答。
 *
 *   所以：一张列表、一个登记入口，点「登记」时先选类型、再给该类型
 *   自己的表单。底下仍然是两张表、两条权限（repository.manage /
 *   storage_target.manage）—— 合并的是入口，不是模型。
 *
 * ★ 登记 ≠ 授权。哪个 Agent 能用哪个来源仍在「Agent 配置」里配
 *   （resourceScopes 的 repo / dataset），页尾显式指回去。
 *   唯一的例外是**项目级仓库对项目内 Agent 默认只读**
 *   （domain 的 effectiveResourceScopes）—— 一个项目通常只有一个仓库，
 *   逐个 Agent 授权一遍换不到任何安全性。`write` 仍然要显式授。
 *
 * One list, not two blocks. Repositories and storage targets stay two tables
 * with two permissions underneath — the merge is of the entry point, because
 * "where does this project's code and data live" is one question.
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

/** 登记时可选的三类来源 / The three source kinds you can register */
type SourceKind = 'git' | 'object_storage' | 'local';

/**
 * 类型 → 词条键。模块级常量只存键，不存译文
 * （取不到 hook，而且切语言时不会重算）。
 */
const KIND_KEYS: Record<SourceKind, { label: MessageKey; hint: MessageKey }> = {
  git: { label: 'ws.kindGit', hint: 'ws.kindGitHint' },
  object_storage: { label: 'ws.kindObject', hint: 'ws.kindObjectHint' },
  local: { label: 'ws.kindLocal', hint: 'ws.kindLocalHint' },
};

/** 列表里的一行：两类来源在这里被抹平成同一个形状 */
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
   * ★ 两个查询里任何一个塌了都整页报错，而不是显示半张列表。
   *   半张列表看起来就是「另一类一个都没登记」—— 而那正是用户接下来
   *   会去重复登记一遍的理由。
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
   * ★ 按 ref 排序而不是按类型分组 —— 分组渲染出来又是两个板块，
   *   而 ref 是用户在 Agent 授权里实际会引用的那个键。
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

      {/* ★ 环境问题在这一页说清楚，而不是等第一次派发才炸 */}
      {!repoData.gitAvailable && (
        <Notice tone="error">
          {t('agentCfg.repo.gitProblem', { problem: repoData.gitProblem ?? '' })}
        </Notice>
      )}
      {!repoData.sshAvailable && repoData.repositories.some((r) => r.authKind === 'ssh_key') && (
        <Notice tone="error">{repoData.sshProblem}</Notice>
      )}

      {/*
        ★★ 白名单只管宿主机目录那一类，但要一直显示。
          它是**部署环境**的变量（APOS_LOCAL_MOUNT_ROOTS），管理员在界面上
          改不动也看不到，而一条 local 登记过不过闸完全由它决定 ——
          不显示的话，被闸掉的登记在页面上和正常的一模一样，
          直到第一次派发才报「不在允许挂载的范围内」。
      */}
      <Notice tone={storeData.localMountRestricted ? 'info' : 'warning'}>
        {storeData.localMountRestricted ? (
          <>
            {t('storage.mountRoots')}
            {storeData.localMountRoots.map((r) => (
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
        ★ 授权在 Agent 配置那一页 —— 登记一个来源不等于哪个 Agent 看得见它。
          唯一的例外是项目级仓库的默认只读，这条也要说出来：不说的话，
          「我什么都没配，它怎么读到了」同样是个查不出来的问题。
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
 * 先选类型，再填表单。
 *
 * ★★ 类型必须在**表单之前**问，而不是做成表单里的一个下拉框。
 *   三类的字段几乎不重叠（远端地址 / 默认分支 vs bucket / 寻址风格 vs
 *   宿主机路径），同一张表单里切类型会让已填的一半字段突然消失，
 *   而用户不会认为那是「不适用」，只会认为自己填的东西丢了。
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
