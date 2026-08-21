import { agent } from './messages/zh/agent';
import { analytics } from './messages/zh/analytics';
import { board } from './messages/zh/board';
import { common } from './messages/zh/common';
import { errors } from './messages/zh/errors';
import { graph } from './messages/zh/graph';
import { plan } from './messages/zh/plan';
import { policy } from './messages/zh/policy';
import { requirement } from './messages/zh/requirement';
import { settings } from './messages/zh/settings';
import type { en } from './en';

/**
 * 中文词条表 / Chinese catalog.
 *
 * ★★ 类型钉死在 en 上：`Record<keyof typeof en, string>`。
 *   en 里加了新键而这里没补，`tsc` 当场报错 —— 而不是上线后中文界面上
 *   突然冒出一句英文，或者更糟，一个键名。
 *   Typed against `en`, so a missing key fails the build instead of leaking
 *   an English string (or a raw key) into the Chinese UI.
 *
 * ★ 每个模块**各自**也钉在对应的英文模块上（见 `messages/zh/*.ts`）。
 *   只在这里钉一次的话，少一个键的报错会指向这整张表 —— 2600 条里少了哪一条，
 *   得自己找。逐模块钉死之后，报错直接指到是哪一块。
 *   Each module is typed against its English counterpart as well, so a missing
 *   key points at the module rather than at a 2,600-entry object.
 */
export const zh: Record<keyof typeof en, string> = {
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
