// Shared ESLint flat config. Packages and apps run `eslint .`, which walks up to this file.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import nextPlugin from '@next/eslint-plugin-next';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { boundaryConfigs } from './tools/eslint/boundaries.mjs';

const rootDir = import.meta.dirname;

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/.next/**',
    '**/next-env.d.ts',
    '**/.turbo/**',
    '**/coverage/**',
    '**/playwright-report*/**',
    '**/test-results*/**',
  ]),
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: rootDir },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // apps/web: Next.js and React Hooks rules. These two plugins are used directly instead of
  // eslint-config-next, which pulls in eslint-plugin-react and eslint-plugin-import, and both
  // declare a peer range that stops at ESLint 9 (this repo is on ESLint 10).
  {
    basePath: rootDir,
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
    languageOptions: { globals: globals.browser },
  },
  { basePath: rootDir, files: ['apps/web/**/*.{ts,tsx}'], ...reactHooks.configs.flat.recommended },
  prettier,
  ...boundaryConfigs({ rootDir }),
]);
