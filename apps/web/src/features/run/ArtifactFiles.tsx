import { useT } from '../../lib/i18n';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { Button } from '@/components/ui/button';

/**
 * 产物文件浏览。
 *
 * ★★ 页面此前**看不到** Agent 改出来的文件。
 *
 *   本地交付只在产物上记了一个归档路径与变更集摘要，于是产物页能显示
 *   「改了 12 个文件」和文件名，却打不开任何一个 —— 用户要看内容只能上服务器。
 *
 * ★ 走 artifactId + 相对路径，绝不碰宿主机绝对路径：那既是部署结构的泄露，
 *   浏览器拿到了也访问不了。解析与越界防护都在服务端（artifact-files.ts）。
 */
export function ArtifactFiles({ artifactId }: { artifactId: string }) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);

  const list = useQuery({
    queryKey: qk.artifactFiles(artifactId),
    queryFn: () => api.artifactFiles(artifactId),
  });

  const content = useQuery({
    queryKey: qk.artifactFile(artifactId, open ?? ''),
    queryFn: () => api.artifactFile(artifactId, open!),
    enabled: open !== null,
  });

  if (list.isPending) return <p className="text-[11px] text-slate-400">{t('common.loading')}</p>;
  // ★ 拉不到就不渲染这一块：git / 对象存储的产物本来就没有本地文件可浏览
  if (list.isError || !list.data) return null;

  const d = list.data;
  if (!d.available) {
    /**
     * ★ 目录没了要说出来，而不是显示一个空列表。
     *   空列表读起来像「这次没产出」，而真相是产出被回收了。
     */
    return <p className="mt-1 text-[11px] text-amber-700">{d.reason}</p>;
  }

  const files = d.files.filter((f) => !f.isDirectory);

  return (
    <div className="mt-1.5 rounded border border-slate-200">
      <div className="flex items-center gap-2 border-b border-slate-100 px-2 py-1">
        <span className="text-[11px] text-slate-500">
          {t('artifact.fileCount', { count: files.length })}
        </span>
        {d.truncated && (
          <span className="text-[11px] text-amber-700">{t('artifact.truncated')}</span>
        )}
        {/* ★ 如实说明没有对照 diff 的原因，而不是让人以为功能坏了 */}
        {!d.diffAvailable && (
          <span className="ml-auto text-[11px] text-slate-400">{t('artifact.noDiff')}</span>
        )}
      </div>

      <ul className="max-h-40 overflow-y-auto">
        {files.map((f) => (
          <li key={f.path}>
            <Button variant="ghost"
              // ★ 被删掉的文件不在归档里，点开也没有内容可看
              disabled={f.change === 'deleted'}
              onClick={() => setOpen(open === f.path ? null : f.path)}
              className={clsx('h-auto p-0 font-normal whitespace-normal hover:bg-transparent justify-start', 
                'flex w-full items-center gap-2 px-2 py-0.5 text-left text-[11px]',
                f.change === 'deleted' ? 'cursor-default' : 'hover:bg-slate-50',
                open === f.path && 'bg-slate-100',
              )}
            >
              {/*
                ★ 改动类型要标出来：只列文件名的话，「新写了这个文件」和
                  「改了这个文件」分不清 —— 而 review 时对两者的看法完全不同。
              */}
              <span
                className={clsx(
                  'w-4 shrink-0 text-center font-mono',
                  f.change === 'added'
                    ? 'text-green-700'
                    : f.change === 'modified'
                      ? 'text-amber-700'
                      : f.change === 'deleted'
                        ? 'text-red-700'
                        : 'text-slate-300',
                )}
                title={f.change ?? undefined}
              >
                {f.change === 'added' ? '+' : f.change === 'modified' ? '~' : f.change === 'deleted' ? '−' : ''}
              </span>
              <span
                className={clsx(
                  'min-w-0 flex-1 truncate font-mono',
                  f.change === 'deleted' ? 'text-slate-400 line-through' : 'text-slate-700',
                )}
              >
                {f.path}
              </span>
              <span className="shrink-0 tabular-nums text-slate-400">
                {f.change === 'deleted' ? '' : sizeOf(f.size)}
              </span>
            </Button>
          </li>
        ))}
      </ul>

      {open !== null && (
        <div className="border-t border-slate-100 p-2">
          {content.isPending && <p className="text-[11px] text-slate-400">{t('common.loading')}</p>}
          {content.data?.preview !== null && content.data?.preview !== undefined ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-[10px] leading-4 text-slate-600">
              {content.data.preview}
            </pre>
          ) : (
            content.data && (
              <div className="space-y-1 text-[11px] text-slate-500">
                {/* ★ 不给预览时要说清楚为什么，并给出下载这条路 */}
                <p>{content.data.reason}</p>
                <a
                  href={`/api/v1/artifacts/${artifactId}/download/${open
                    .split('/')
                    .map(encodeURIComponent)
                    .join('/')}`}
                  className="text-sky-700 underline"
                >
                  {t('artifact.download')}
                </a>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
