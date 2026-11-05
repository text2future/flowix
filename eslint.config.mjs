import { readdirSync } from 'node:fs';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

const FEATURES = readdirSync('./app/flowix-web/features', { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

/**
 * 跨 feature 只允许走对方的 public/ 入口。
 *
 * 这条规则取代了 scripts/check-layer-boundaries.mjs 里逐文件硬编码的白名单：
 * 允许/禁止清单在 lint 时从文件系统推导，新增 feature 或子目录自动生效，
 * 文件改名/移动不会让规则静默失效。
 *
 * 注意：no-restricted-imports 的 group 不支持 `!` 否定（会命中所有模式），
 * 所以这里改为「枚举除 public/ 以外的实际子路径」。
 * 存量违规由 architecture-baseline.json + scripts/check-architecture.mjs 管理。
 */
function privateEntrypointsOf(feature) {
  const base = `./app/flowix-web/features/${feature}`;
  // 注意：no-restricted-imports 的 pattern 是前缀匹配（`@features/memo/store`
  // 会同时命中 `@features/memo/store/note-store`），因此不能把模块根
  // `@features/memo` 写进列表——那会把 public/ 一起封掉。
  // 裸 barrel（`@features/memo`）由 check-architecture 的基线负责拦截。
  const patterns = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (entry.name === 'public' || entry.name === 'index.ts') continue;
    if (entry.isDirectory()) {
      patterns.push(`@features/${feature}/${entry.name}`);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      patterns.push(`@features/${feature}/${entry.name.replace(/\.tsx?$/, '')}`);
    }
  }
  return patterns;
}

function crossFeatureRule(self) {
  return {
    files: [`app/flowix-web/features/${self}/**/*.{ts,tsx}`],
    ignores: [`app/flowix-web/features/${self}/**/*.test.{ts,tsx}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // group 必须是去重的字符串数组（ESLint 的 schema 走 uniqueItems），
              // 否则会报一个完全不相关的 additionalProperties 错误。
              group: [...new Set(FEATURES.filter((other) => other !== self).flatMap(privateEntrypointsOf))],
              message:
                '跨 feature 只能 import 对方的 public/ 入口；需要新能力请先补 public API。',
            },
          ],
        },
      ],
    },
  };
}

export default tseslint.config(
  {
    ignores: [
      '.build/**',
      'dist/**',
      'node_modules/**',
      // Agent 工作区（.gitignore 已忽略）：本地分析/审计脚本，不属于仓库代码。
      '.workbuddy/**',
      'app/target/**',
      'app/flowix-desktop/**',
      'app/flowix-cli/**',
      'app/flowix-core/**',
      'dsh/**',
      'dsh-appserver/**',
      'dsh-flowix-memory/**',
      'app/flowix-web/public/**',
      'scripts/**',
      'examples/**',
      'public/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['app/flowix-web/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // 这两条替代了「靠人盯」的异步错误处理：裸 void / 未处理的 promise 直接报错。
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'warn',

      // 与 scripts/check-frontend-debt.mjs 的 MAX_EXPLICIT_ANY = 0 保持一致。
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-empty-object-type': 'off',
      // 沿用仓库既有的 `_unused` 约定（tsconfig 的 noUnusedParameters 也忽略下划线前缀）。
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      // 仓库里有刻意保留的 NBSP 正则（HTML 实体清洗），跳过正则字面量。
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
    },
  },
  ...FEATURES.map((name) => crossFeatureRule(name)),
  {
    // foundation 与组合根对 feature 的依赖由 check-architecture 的基线管理；
    // 这里不禁用，否则 app/ 下 25 条存量会与基线规则重复报错。
    files: ['app/flowix-web/app/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['app/flowix-web/platform/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.config.{js,ts,mjs}'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      'no-console': 'off',
    },
  },
);
