/**
 * 图表配色。
 *
 * ★ 数据色是跑过校验的，不是挑出来的。
 *   `dataviz` 技能的 validate_palette.js，白底：
 *
 *     两类序列 #2a78d6 / #eb6834
 *       亮度带 PASS · 彩度下限 PASS · 色盲区分 ΔE 24.7 PASS
 *       正常视觉 ΔE 33.6 PASS · 对比度 ≥3:1 PASS
 *
 *     有序色阶（单色相，浅→深）
 *       #86b6ef #5598e7 #2a78d6 #1c5cab #0d366b
 *       单调 PASS · 相邻明度差 ≥0.06 PASS · 浅端对比 2.11:1 PASS
 *
 *   蓝色阶在白底上**只放得下 5 级**：再加一级要么相邻两步分不开，
 *   要么最浅那级糊进背景。这个上限直接决定了图表设计 ——
 *   需要 6 类的图（比如按阶段的累积流图）就不该用色阶画，
 *   而不是硬凑第六个颜色。
 *
 * ★★ 数据色**不跟主题走**，框架色跟。
 *
 *   加了深色主题之后最容易做错的一件事，是把这五个蓝直接反过来用 ——
 *   那是在深底上从没校验过的一组色，明度带、彩度下限、色盲 ΔE 全部作废。
 *   这几个值是在白底上跑出来的，同时也是在深底上仍然读得出的中高明度段
 *   （最浅的 #86b6ef 在 #0d1422 上对比度 8.4:1），所以两个主题共用一套。
 *
 *   真要为深色单独取一套，得重新在深底上取步、重新跑一遍 validate_palette.js，
 *   而不是把浅色值反过来。
 *
 *   框架色（网格、轴、刻度字、图表底）则必须跟主题 —— 它们的职责就是
 *   「和页面融为一体」，留在浅色值上会让图表看起来像贴在页面上的一张白纸。
 */

/** 分类：两类就够了，本页没有需要三类以上着色的图 */
export const SERIES = {
  /** 有效工作、主趋势线 */
  primary: '#2a78d6',
  /** 等待、损耗 —— 蓝的对立面，色盲下也分得开 */
  waiting: '#eb6834',
} as const;

/** 有序色阶。浅→深，最多 5 级。 */
export const ORDINAL = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b'] as const;

/**
 * 状态色。固定不参与主题，且永远配图标 + 文字 ——
 * 光靠颜色说「这个不好」，色盲用户与打印件上都读不到。
 */
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

/**
 * 图表框架用 app 自己的 slate 灰阶，不用配色表里的暖灰 ——
 * 一页之内出现两套中性色，图表会看起来像贴上去的。
 *
 * ★ 走 CSS 变量而不是写死的 hex：SVG 的 stroke/fill 属性认 var()，
 *   于是换主题时图表跟着换，不用把颜色搬进 React 状态里重渲染一遍。
 *   令牌定义见 src/index.css 的 --chart-*。
 */
export const CHROME = {
  grid: 'var(--chart-grid)',
  axis: 'var(--chart-axis)',
  muted: 'var(--chart-muted)',
  ink: 'var(--chart-ink)',
  surface: 'var(--chart-surface)',
} as const;

/** 标记规格，各图共用，免得每处各写一套 */
export const MARK = {
  /** 条形最大粗细：留白比填满好看，也更好读 */
  barMax: 20,
  /** 数据端圆角，基线端保持方角 */
  barRadius: 4,
  lineWidth: 2,
  dotRadius: 4,
  /** 相邻填充之间留出的底色缝隙，用白色分隔而不是描边 */
  gap: 2,
} as const;
