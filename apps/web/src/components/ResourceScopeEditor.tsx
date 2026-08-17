import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';

/**
 * 资源范围编辑器 —— 可增删的多条，来源是**已登记的**资源。
 *
 * ★★ 它取代的那个表单只有两格：一个仓库 + 一个数据集。
 *
 *   数据模型一直支持任意多条，而表单把它们压成两条 —— 于是**编辑**一个
 *   授权了三个仓库的 Agent 时，保存会把另外两条**静默删掉**。
 *   没有报错、没有提示，页面上那两个仓库从来就没显示过。
 *   这类 bug 的成本不在于丢配置，而在于丢的是**授权**：撤销一条授权
 *   本该是一个决定，这里它成了打开表单点保存的副作用。
 *
 * ★ ref 从登记表里选，不再手打。手打的 ref 一个字母敲错，表现是任务跑到
 *   准备工作区那一步失败，而报错说的是「挂载失败」——它不指向
 *   「你写的这个仓库不存在」。仍然留一个自定义入口：登记之外的资源
 *   （外部服务、环境）现在还没有登记表。
 *
 * A repeatable editor fed from registered resources. The form it replaces had
 * exactly two slots, so editing an agent with three repository grants silently
 * dropped two of them on save — turning "revoke an authorisation", which should
 * be a decision, into a side effect of opening a form.
 */

export interface ScopeRow {
  kind: string;
  ref: string;
  access: string;
}

const KINDS = ['repo', 'dataset', 'database', 'env', 'external_service'] as const;

export function ResourceScopeEditor({
  value,
  onChange,
  projectId,
}: {
  value: ScopeRow[];
  onChange: (next: ScopeRow[]) => void;
  /** 传了就只列这个项目的资源；不传列全组织可见的 */
  projectId?: string;
}) {
  const t = useT();

  const repos = useQuery({
    queryKey: qk.repositories(projectId),
    queryFn: () => api.repositories(projectId),
  });
  const targets = useQuery({
    queryKey: qk.storageTargets(projectId),
    queryFn: () => api.storageTargets(projectId),
  });

  /**
   * ★ 已登记的 ref 按类型分组，供下拉选择。
   *   存储目标既可能是数据集也可能是别的形态，一律先归到 dataset ——
   *   它是 workspace-providers 里非 Git 来源的默认落点。
   */
  const known: Record<string, { ref: string; name: string }[]> = {
    repo: (repos.data?.repositories ?? []).map((r) => ({ ref: r.ref, name: r.name })),
    dataset: (targets.data?.storageTargets ?? []).map((s) => ({ ref: s.ref, name: s.name })),
  };

  const update = (index: number, patch: Partial<ScopeRow>) =>
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <p className="text-[11px] text-slate-500">{t('scopes.empty')}</p>
      )}

      {value.map((row, i) => (
        /**
         * ★ key 只用下标，**不能**把 ref 拼进去。
         *
         *   拼了的话，每敲一个字符 key 就变，React 把整行当成新元素重建 ——
         *   输入框随之失焦，用户打「stripe」只留得下一个 s。行是就地编辑的，
         *   顺序不会变，下标在这里是稳定身份。
         */
        <div key={i} className="flex items-center gap-1">
          <select
            value={row.kind}
            onChange={(e) => update(i, { kind: e.target.value, ref: '' })}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
            aria-label={t('scopes.kind')}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`scopes.kind.${k}` as Parameters<typeof t>[0])}
              </option>
            ))}
          </select>

          {/*
            ★ 有登记表的类型给下拉，没有的给输入框。
              一律给输入框就回到了「敲错了没人告诉你」；一律给下拉则
              外部服务这类还没有登记表的资源根本填不进去。
          */}
          {known[row.kind] ? (
            <select
              value={row.ref}
              onChange={(e) => update(i, { ref: e.target.value })}
              className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
              aria-label={t('scopes.ref')}
            >
              <option value="">{t('scopes.choose')}</option>
              {known[row.kind]!.map((r) => (
                <option key={r.ref} value={r.ref}>
                  {r.name}（{r.ref}）
                </option>
              ))}
              {/* ★ 保留库里已有但登记表里查不到的 ref：不保留的话，
                  打开表单就把它清空了，而那正是这个组件要修的那个 bug */}
              {row.ref && !known[row.kind]!.some((r) => r.ref === row.ref) && (
                <option value={row.ref}>{t('scopes.unregistered', { ref: row.ref })}</option>
              )}
            </select>
          ) : (
            <input
              value={row.ref}
              onChange={(e) => update(i, { ref: e.target.value })}
              className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
              aria-label={t('scopes.ref')}
            />
          )}

          <select
            value={row.access}
            onChange={(e) => update(i, { access: e.target.value })}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
            aria-label={t('scopes.access')}
          >
            <option value="read">{t('scopes.access.read')}</option>
            <option value="write">{t('scopes.access.write')}</option>
            {/*
              ★ `none` 要能选中。删掉一条等于回落到「项目仓库默认只读」，
                而 none 是显式的「这个不给」—— 撤销一条默认授权只有这一种写法
                （见 domain 的 effectiveResourceScopes）。
            */}
            <option value="none">{t('scopes.access.none')}</option>
          </select>

          <Button
            variant="outline"
            size="xs"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            className="text-rose-600"
          >
            {t('common.remove')}
          </Button>
        </div>
      ))}

      <Button
        variant="outline"
        size="xs"
        onClick={() => onChange([...value, { kind: 'repo', ref: '', access: 'read' }])}
      >
        + {t('scopes.add')}
      </Button>
    </div>
  );
}
