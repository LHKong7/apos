import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * ★ 这份配置有意只保留「会变成 bug 的规则」，不管风格。
 *
 *   风格由 tsconfig 的 strict 一族和 code review 兜着；把格式规则塞进来，
 *   结果是每次跑出上百条噪音，然后所有人开始习惯性忽略 lint 输出 ——
 *   那时候真正的错误也一起被忽略了。
 *
 *   typecheck 已经覆盖类型问题，所以这里的重点是类型系统看不见的东西：
 *   React Hook 依赖、被吞掉的 Promise、写了不用的变量。
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      // ★ Vite 的依赖预构建缓存。它已被 git 忽略，但没被 eslint 忽略 ——
      //   于是只要本机跑过一次 dev server，`pnpm lint` 就会在几百个
      //   第三方文件上报错，而那些代码不是我们写的也改不了
      '**/.vite/**',
      // 临时探针脚本（.xxx-tmp.mjs），跑完就删，不进 lint
      '**/.*-tmp.mjs',
      'packages/db/migrations/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // 后端与脚本跑在 Node，前端跑在浏览器；两侧都用得上 fetch / URL / console
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // 下划线前缀是本仓库表达「有意不用」的既定写法
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      /**
       * ★ 开着。全仓库只有一处 `any`，而且已经带了 disable 注释 ——
       *   说明这里的规矩本来就是「用 any 要给理由」。关掉它等于把
       *   这条已经守住的纪律作废，而开着的成本是零。
       */
      '@typescript-eslint/no-explicit-any': 'error',
      // 空接口/命名空间之类的风格规则不参与
      '@typescript-eslint/no-empty-object-type': 'off',
      /**
       * ★ 全角空格（U+3000）在中文界面文案里是正经排版字符，
       *   `🤖 4　👤 3` 用半角空格会挤在一起。默认配置只放过普通字符串，
       *   而这些文案基本都在模板串和注释里，不放过就等于禁止中文排版。
       *   代码位置上的全角空格仍然会报 —— 那才是真会出事的那种。
       */
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipComments: true }],
    },
  },

  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      /**
       * ★ 这条是本仓库最该开的一条。依赖数组漏项在 SSE 驱动的界面上
       *   表现为「数据变了但这一块没跟着变」—— 看起来像后端没推，
       *   实际是前端闭包拿的是旧值。这类问题极难靠肉眼 review 发现。
       */
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'error',
    },
  },

  {
    files: ['**/*.test.{ts,tsx}', 'apps/web/scripts/**', 'scripts/**'],
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
);
