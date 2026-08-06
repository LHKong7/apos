import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 语义色。看板靠状态色传递信息量，命名按含义而不是色相，
        // 换主题时不用逐处改
        gate: '#f59e0b',
        overdue: '#ef4444',
        blocked: '#f97316',
        agent: '#6366f1',
      },
      keyframes: {
        'card-land': {
          '0%': { transform: 'scale(0.96)', boxShadow: '0 0 0 3px rgb(99 102 241 / 0.5)' },
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
      },
      animation: {
        'card-land': 'card-land 1.5s ease-out',
        // 只跳一次 —— 持续闪烁会让人关掉页面（页面文档 05 §5.4）
        'pulse-once': 'pulse-once 0.6s ease-in-out 2',
        breathe: 'breathe 1.6s ease-in-out infinite',
      },
    },
  },
} satisfies Config;
