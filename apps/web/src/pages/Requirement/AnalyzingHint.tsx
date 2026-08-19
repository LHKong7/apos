import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { duration } from '@/lib/format';

/**
 * 分析进行中的说明条 / A live hint while the analysis runs.
 *
 * ★★ 这一段替代的是一个静止不动的「Analyzing…」。
 *
 *   实测一次真实分析要 47 秒，而这四十七秒里界面上唯一的变化是没有变化：
 *   没有进度、没有已耗时、没有预期时长、也没有取消。用户分不出
 *   「在跑」和「挂了」—— 而这两者该做的事正好相反（等着 / 刷新重来）。
 *
 * ★ 只报**已耗时**，不编进度条。这一步是一次 Agent 调用，没有可分的阶段，
 *   假进度条比没有更糟：它会在 90% 上停很久，然后用户开始怀疑一切数字。
 *
 * ★ 同时说清「可以离开」。分析在服务端跑，关掉页面它照跑 ——
 *   不说的话，用户会守着这个页面，因为他不知道走开会不会前功尽弃。
 *
 * Shows elapsed time rather than a fake progress bar: this is one agent call
 * with no divisible phases, and a bar stuck at 90% teaches people to distrust
 * every number on the page.
 */
export function AnalyzingHint({ startedAt }: { startedAt: number }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  /** ★ 超过一分钟就换成「Nm Ns」，纯秒数读到 143 已经要心算了 */
  const elapsed = seconds < 60 ? `${seconds}s` : duration(seconds / 60);

  return (
    <p
      className="mt-1 text-[11px] leading-5 text-slate-500"
      role="status"
      aria-live="polite"
    >
      {t('requirement.detail.analyzingElapsed', { elapsed })}
      {' · '}
      {t('requirement.detail.analyzingTypical')}
      {' · '}
      {t('requirement.detail.analyzingLeaveOk')}
    </p>
  );
}
