import { describe, expect, it } from 'vitest';
import { BUCKETS, BUCKET_OF, type Bucket } from './buckets';
import * as en from './en';
import * as zh from './zh';

/**
 * 词条表的**组织方式**本身也要有测试。
 *
 * ★★ 拆成十个文件解决的是「单文件 2900 行」，解决不了「新键放错文件」。
 *
 *   而放错文件是会累积的：一年后 `common.ts` 里躺着一半的 analytics 词条，
 *   于是「按区域分文件」这件事名存实亡，回到拆分之前的状态 ——
 *   只不过这次分散在十个文件里，比原来更难看清。
 *
 *   这三条断言让分组成为**被检查的事实**：放错文件、忘了登记新前缀、
 *   或者删干净了某个前缀却把它留在归属表里，都会红。
 *
 *   Splitting the catalog fixed one 2,900-line file; it does not stop a key
 *   from landing in the wrong module. Misplacement accumulates, and a year
 *   later "organized by area" is true only on paper.
 */

const MODULES: Record<Bucket, Record<string, string>> = {
  common: en.common,
  errors: en.errors,
  board: en.board,
  requirement: en.requirement,
  plan: en.plan,
  agent: en.agent,
  analytics: en.analytics,
  policy: en.policy,
  settings: en.settings,
  graph: en.graph,
};

const ZH_MODULES: Record<Bucket, Record<string, string>> = {
  common: zh.common,
  errors: zh.errors,
  board: zh.board,
  requirement: zh.requirement,
  plan: zh.plan,
  agent: zh.agent,
  analytics: zh.analytics,
  policy: zh.policy,
  settings: zh.settings,
  graph: zh.graph,
};

const prefixOf = (key: string) => key.split('.')[0]!;

describe('词条表的组织 / catalog structure', () => {
  /**
   * ★ 报的是「这条键在哪儿、该去哪儿」，不是一句「有键放错了」——
   *   红了的时候，人要的是能直接照着搬的指令。
   */
  it('★ 每条键都在它前缀对应的文件里', () => {
    const misplaced: string[] = [];
    for (const [bucket, entries] of Object.entries(MODULES)) {
      for (const key of Object.keys(entries)) {
        const belongs = BUCKET_OF[prefixOf(key)];
        if (belongs !== bucket) {
          misplaced.push(`${key} 在 ${bucket}.ts，该在 ${belongs ?? '（前缀没登记进 buckets.ts）'}`);
        }
      }
    }
    expect(misplaced).toEqual([]);
  });

  /** ★ 中英两侧必须同构：同一条键在两边住在同一个文件里 */
  it('★ 中英两侧的分组一致', () => {
    for (const bucket of Object.keys(MODULES) as Bucket[]) {
      expect(Object.keys(ZH_MODULES[bucket]).sort()).toEqual(
        Object.keys(MODULES[bucket]).sort(),
      );
    }
  });

  /**
   * ★★ 反过来查：归属表里登记的每个前缀都要真的有键。
   *
   *   没有这一条，删光了某个区域的词条之后，它的前缀会永远留在
   *   `buckets.ts` 里 —— 那张表于是慢慢变成一份「曾经有过什么」的考古记录，
   *   而读它的人以为那是现状。
   */
  it('★ 归属表里没有已经没人用的前缀', () => {
    const used = new Set(
      Object.values(MODULES).flatMap((m) => Object.keys(m).map(prefixOf)),
    );
    const stale = Object.entries(BUCKETS).flatMap(([bucket, prefixes]) =>
      prefixes.filter((p) => !used.has(p)).map((p) => `${p}（登记在 ${bucket}）`),
    );
    expect(stale).toEqual([]);
  });
});
