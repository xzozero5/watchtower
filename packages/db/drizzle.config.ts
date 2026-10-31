import { defineConfig } from 'drizzle-kit';

// Used by `pnpm db:generate` only. Migrations are applied by src/migrator.ts (up and down), not
// by drizzle-kit, because every migration must be reversible.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
});
