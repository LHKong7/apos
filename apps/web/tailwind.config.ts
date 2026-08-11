import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

/**
 * ★★ 调色盘整体接到 CSS 变量上（令牌定义见 src/index.css）。
 *
 *   Tailwind 自带的 slate/amber/red… 是**写死的十六进制**，
 *   一旦页面里写了 `text-slate-500`，那处的颜色就和主题脱钩了。
 *   把这些色阶重新指向令牌之后，`text-slate-500` 的含义从
 *   「#64748b」变成「次要文字」—— 全站 1500+ 处已有类名一字不改，
 *   直接获得深/浅两套主题。
 *
 * ★ 写成 `rgb(var(--x) / <alpha-value>)` 而不是 `var(--x)`：
 *   前者才能让 `bg-gate/15`、`bg-white/70` 这类透明度修饰符算出结果。
 */
const token = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

/**
 * shadcn 的令牌不带 `--c-` 前缀（它有自己一套约定名），但同样是 R G B 三元组，
 * 所以透明度修饰符照样能算。
 */
const shadcn = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

/** 生成一整条 50→900 的色阶，省得十个色相各抄一遍 */
const ramp = (hue: string) =>
  Object.fromEntries(
    [50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((step) => [step, token(`${hue}-${step}`)]),
  ) as Record<string, string>;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // 深色由 <html data-theme> 决定，不跟随系统 —— 用户在顶栏选过的那次要算数
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // 中性色：全站的面、边、字都在这条阶上
        slate: ramp('slate'),
        // 状态色相
        amber: ramp('amber'),
        red: ramp('red'),
        rose: ramp('rose'),
        orange: ramp('orange'),
        emerald: ramp('emerald'),
        green: ramp('green'),
        sky: ramp('sky'),
        indigo: ramp('indigo'),

        /** 卡面。深色下不是纯白，而是比页底浮起一层的深蓝灰 */
        white: token('white'),

        // 语义色。看板靠状态色传递信息量，命名按含义而不是色相，
        // 换主题时不用逐处改
        gate: token('gate'),
        overdue: token('overdue'),
        blocked: token('blocked'),
        agent: token('agent'),

        /** 品牌色。只出现在导航、焦点环、主行动与「正在发生」的发光上 */
        brand: {
          DEFAULT: token('brand'),
          alt: token('brand-alt'),
          far: token('brand-far'),
        },

        /** 弹层遮罩 —— 深浅两套的黑度差得远，不能靠一个 slate-900/20 顶过去 */
        scrim: token('scrim'),

        /**
         * shadcn/ui 的语义色。定义在 index.css 的「令牌桥」一段，
         * 全部是指向 --c-* 的引用 —— 所以这些名字天生就有深浅两套主题。
         *
         * ★ 与上面那批是**别名关系而不是替代**：`bg-card` 和 `bg-white`
         *   指的是同一个东西。存量代码继续用 slate/white，
         *   ui/ 下的 shadcn 组件用这批，两边不打架。
         */
        border: shadcn('border'),
        input: shadcn('input'),
        ring: shadcn('ring'),
        background: shadcn('background'),
        foreground: shadcn('foreground'),
        primary: {
          DEFAULT: shadcn('primary'),
          foreground: shadcn('primary-foreground'),
        },
        secondary: {
          DEFAULT: shadcn('secondary'),
          foreground: shadcn('secondary-foreground'),
        },
        destructive: {
          DEFAULT: shadcn('destructive'),
          foreground: shadcn('destructive-foreground'),
        },
        muted: {
          DEFAULT: shadcn('muted'),
          foreground: shadcn('muted-foreground'),
        },
        accent: {
          DEFAULT: shadcn('accent'),
          foreground: shadcn('accent-foreground'),
        },
        popover: {
          DEFAULT: shadcn('popover'),
          foreground: shadcn('popover-foreground'),
        },
        card: {
          DEFAULT: shadcn('card'),
          foreground: shadcn('card-foreground'),
        },
      },

      fontFamily: {
        sans: [
          'Inter var',
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'JetBrains Mono',
          'Menlo',
          'Consolas',
          'Liberation Mono',
          'monospace',
        ],
      },

      /**
       * ★ 圆角整体放大一档。这一版之前全站是 `rounded`（4px），
       *   小圆角在密集界面里看起来更接近「表格」而不是「面板」。
       *   改在这里而不是逐处换类名 —— 三百多处 `rounded` 一次到位。
       */
      borderRadius: {
        DEFAULT: '0.5rem',
        sm: '0.375rem',
        md: '0.625rem',
        lg: '0.75rem',
        xl: '1rem',
        '2xl': '1.25rem',
        '3xl': '1.75rem',
      },

      /**
       * 阴影带一圈微光描边（rim）。深色界面里单纯的投影是看不见的 ——
       * 让面「浮起来」的其实是顶边那道更亮的线。
       */
      boxShadow: {
        sm: '0 1px 2px 0 rgb(var(--shadow-color) / var(--shadow-strength)), inset 0 1px 0 0 rgb(var(--rim) / var(--rim-alpha))',
        DEFAULT:
          '0 2px 8px -2px rgb(var(--shadow-color) / var(--shadow-strength)), inset 0 1px 0 0 rgb(var(--rim) / var(--rim-alpha))',
        md: '0 6px 16px -4px rgb(var(--shadow-color) / var(--shadow-strength)), inset 0 1px 0 0 rgb(var(--rim) / var(--rim-alpha))',
        lg: '0 12px 28px -8px rgb(var(--shadow-color) / var(--shadow-strength)), inset 0 1px 0 0 rgb(var(--rim) / var(--rim-alpha))',
        xl: '0 24px 56px -16px rgb(var(--shadow-color) / calc(var(--shadow-strength) * 1.4)), inset 0 1px 0 0 rgb(var(--rim) / var(--rim-alpha))',
      },

      keyframes: {
        'card-land': {
          '0%': { transform: 'scale(0.96)', boxShadow: '0 0 0 3px rgb(var(--c-brand) / 0.55)' },
          '100%': { transform: 'scale(1)', boxShadow: '0 0 0 0 transparent' },
        },
        'pulse-once': {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.02)' },
        },
        breathe: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        /** 抽屉/弹层入场。位移很小 —— 大幅度滑入会让人等它演完 */
        'slide-in-right': {
          '0%': { transform: 'translateX(1.5rem)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        'fade-in-up': {
          '0%': { transform: 'translateY(0.375rem)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        /** 状态点外扩的一圈涟漪，表示「这是活的」*/
        'ping-soft': {
          '0%': { transform: 'scale(1)', opacity: '0.5' },
          '75%, 100%': { transform: 'scale(2.4)', opacity: '0' },
        },
      },
      animation: {
        'card-land': 'card-land 1.5s ease-out',
        // 只跳一次 —— 持续闪烁会让人关掉页面（页面文档 05 §5.4）
        'pulse-once': 'pulse-once 0.6s ease-in-out 2',
        breathe: 'breathe 1.6s ease-in-out infinite',
        shimmer: 'shimmer 1.6s infinite',
        'slide-in-right': 'slide-in-right 220ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        'fade-in-up': 'fade-in-up 200ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        'fade-in': 'fade-in 160ms ease-out',
        'ping-soft': 'ping-soft 1.8s cubic-bezier(0, 0, 0.2, 1) infinite',
      },
    },
  },
  /**
   * shadcn 组件的入场/退场动画靠它：`animate-in`、`fade-in-0`、`zoom-in-95`，
   * 以及 `data-[state=open]:` / `data-[state=closed]:` 这一整套状态选择器。
   *
   * ★ 不装的话组件仍然渲染得出来，但弹层会「啪」地出现和消失 ——
   *   而且没有任何报错，只是看起来很廉价。
   */
  plugins: [animate],
} satisfies Config;
