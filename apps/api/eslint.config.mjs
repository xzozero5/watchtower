// Extends the repo config. NestJS modules and providers are classes with decorators and no
// members, which the strict default of no-extraneous-class rejects.
import { defineConfig } from 'eslint/config';

import root from '../../eslint.config.mjs';

export default defineConfig([
  ...root,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },
]);
