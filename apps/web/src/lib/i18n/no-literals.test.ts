import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 「界面文案一律走 i18n，不许写字面量」—— 给这条规矩配一个守门人。
 *
 * ★★ 这条规矩此前只写在 CLAUDE.md 里，没有任何东西执行它。
 *
 *   而它是**沉默失效**的那一类：写死一句中文，中文界面上看不出任何问题，
 *   要切到英文才会露出来 —— 而写代码的人通常不切。等到有人切了，
 *   已经攒了几十处，一处处找回来比当初写对贵得多。
 *
 *   The rule lived only in CLAUDE.md. Breaking it is invisible in the Chinese
 *   UI and only shows up in English, which is not where the author is looking.
 *
 * ★ 只查**中文**字面量，不查英文。英文写死了也是 bug，但没法用一条正则
 *   把「写死的英文文案」和「类名、枚举值、URL」分开 —— 一条会误报的规则
 *   活不过三次提交，最后一定是被 disable 掉，那时它连中文都不查了。
 *   中文这条判据是确定的：界面代码里出现汉字，只有例外情况是对的。
 */

/**
 * ★ 从**这个文件自己**往上两级找到 src，不用 process.cwd()。
 *   cwd 取决于从哪儿发起 vitest（仓库根、apps/web，或者 IDE），
 *   而这条路径要在三种情况下都对。
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CJK = /[一-鿿]/;

/**
 * ★★ 例外必须逐条写明理由，不能只是一个路径清单。
 *
 *   没有理由的豁免名单会一直变长 —— 每个人都觉得自己这条是特例。
 *   写下理由之后，加一条的成本就变成了「你得说服读到它的人」。
 */
const ALLOWED = [
  {
    file: 'App.tsx',
    why: '语言切换器自己的标签。它必须用**目标语言**的文字写：一个看不懂中文的人，正是靠认出「中文」这两个字才知道那是切语言的按钮。走词条的话，中文界面上它会显示 "EN"、英文界面上显示「中文」—— 恰好每个人都看不懂对自己有用的那一个。',
  },
  {
    file: 'test/fixtures.ts',
    why: '测试夹具里的示例数据（任务标题之类），不是界面文案。',
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 剥掉注释后找字符串/模板里的汉字。
 *
 * ★ 注释里的中文是**要求**而不是违规 —— 这个仓库的注释是中英并行的。
 *   不剥注释的话，这条测试会把每一份写得好的文件都报成违规。
 */
function chineseLiterals(src: string): number[] {
  const hits: number[] = [];
  let i = 0;
  let line = 1;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (!quote) {
      if (c === '\n') {
        line++;
        i++;
        continue;
      }
      if (c === '/' && n === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && n === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
          if (src[i] === '\n') line++;
          i++;
        }
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) {
      quote = null;
      i++;
      continue;
    }
    if (CJK.test(c)) {
      hits.push(line);
      // 跳到本字符串结束，同一条不重复报
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\n') line++;
        if (src[i] === '\\') i++;
        i++;
      }
      quote = null;
      i++;
      continue;
    }
    if (c === '\n') line++;
    i++;
  }
  return hits;
}

describe('界面文案不写字面量 / no hard-coded UI copy', () => {
  it('★ 除了写明理由的例外，界面代码里没有中文字面量', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length).replace(/^\/+/, '');
      // 词条表本身就是文案，测试文件里的中文是用例名与夹具
      if (rel.startsWith('lib/i18n/') || /\.test\.tsx?$/.test(rel)) continue;
      if (ALLOWED.some((a) => rel === a.file)) continue;

      for (const line of chineseLiterals(readFileSync(file, 'utf8'))) {
        offenders.push(`${rel}:${line}`);
      }
    }
    /**
     * ★ 报的是「文件:行号」而不是一句「有 N 处违规」——
     *   红了的时候，人要的是能直接跳过去的位置。
     */
    expect(offenders).toEqual([]);
  });

  /** ★ 例外名单不许无理由增长：每一条都要说清为什么它不该走词条 */
  it('每条例外都写了理由', () => {
    for (const a of ALLOWED) expect(a.why.length).toBeGreaterThan(20);
  });
});
