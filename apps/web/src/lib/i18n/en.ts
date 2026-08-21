import { agent } from './messages/en/agent';
import { analytics } from './messages/en/analytics';
import { board } from './messages/en/board';
import { common } from './messages/en/common';
import { errors } from './messages/en/errors';
import { graph } from './messages/en/graph';
import { plan } from './messages/en/plan';
import { policy } from './messages/en/policy';
import { requirement } from './messages/en/requirement';
import { settings } from './messages/en/settings';

/**
 * English catalog — the single source of truth for keys.
 * 英文词条表 —— 键的唯一真相来源。
 *
 * ★★ `zh.ts` is typed against this object, so a key added here without a
 *   Chinese counterpart is a **compile error**, not a blank label at runtime.
 *   在这里加了键而没在 zh 侧补上，是编译错误而不是运行时的空标签。
 *
 * ★ Keys are `area.thing`, grouped by the screen they belong to. Do not nest
 *   objects: a flat map keeps `t('board.empty')` greppable, and grep is how
 *   anyone finds where a string is used.
 *   键一律 `区域.名字` 的扁平结构 —— 嵌套之后 `t('board.empty')` 就搜不到了，
 *   而搜索是唯一能查清一句话用在哪儿的办法。
 *
 * ★ Interpolation uses `{name}`. Never build a sentence by concatenating
 *   fragments: word order differs between the two languages, and a sentence
 *   assembled from pieces can only be correct in the language it was written in.
 *   插值用 `{name}`。绝不要把句子拆成片段再拼 —— 两种语言语序不同，
 *   拼出来的句子只在写它的那种语言里成立。
 *
 * ★★ The catalog is **split by area, flat inside**. 表按区域分文件，文件内仍是扁平的。
 *
 *   One 2900-line file was the previous shape, and it had two costs. Every
 *   branch that touched copy conflicted at the bottom of the same file. And
 *   its section headers had drifted into names like "addendum two" and
 *   "the last batch" — sections named after *when* they were added rather
 *   than what they hold, which is what happens when the only place to put a
 *   new key is the end.
 *   此前是一个 2900 行的单文件，代价有两处：改文案的分支全在同一个文件尾部冲突；
 *   而它的分节名已经漂成「补遗二」「最后一批」这种 —— 按**加入时间**命名而不是
 *   按内容，那正是「新键只能往末尾加」的必然结果。
 *
 *   Splitting by area does not nest the keys: `t('board.empty')` is still one
 *   grep away. The file a key lives in is an organisational fact, not part of
 *   its name.
 *   按区域分文件不改变键的形态：`t('board.empty')` 照样一搜就到。
 *   键住在哪个文件是组织方式，不是它名字的一部分。
 */
export const en = {
  ...common,
  ...errors,
  ...board,
  ...requirement,
  ...plan,
  ...agent,
  ...analytics,
  ...policy,
  ...settings,
  ...graph,
};

export type MessageKey = keyof typeof en;
