import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * shadcn 组件的类名合并函数。
 *
 * ★★ 为什么不能直接用 clsx —— 全站已经在用 clsx，但那不够。
 *
 *   shadcn 的每个组件都自带一串基础类名，调用方再通过 `className` 覆盖。
 *   光靠 clsx 拼接的话，`<Button className="bg-red-500">` 得到的是
 *   `bg-primary bg-red-500` —— 两条都在，最终哪个生效取决于**它们在
 *   生成的 CSS 文件里的先后顺序**，而那个顺序调用方完全看不见也控制不了。
 *   表现是「我明明传了 className，颜色没变」，或者更糟：本地是对的，
 *   换个构建顺序就变了。
 *
 *   twMerge 认识 Tailwind 的类名语义，同一属性只留后写的那个。
 *
 * ★ 现有代码里那些 `clsx(...)` 不用改：它们拼的是自己的类名，
 *   没有「基础类 vs 覆盖类」的冲突。这个函数是给 ui/ 下的组件用的。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
