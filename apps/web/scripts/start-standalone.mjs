// Starts the standalone server exactly as the Docker image does: copy .next/static and public next
// to server.js (Next.js does not do this itself), then run server.js. Used by the e2e tests so
// they exercise the shipped artefact. Run `next build` first. Reads PORT and HOSTNAME.
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const appDir = join(import.meta.dirname, '..');
// The trace root is the monorepo root (next.config.ts), so server.js sits under apps/web.
const standaloneDir = join(appDir, '.next', 'standalone', 'apps', 'web');
const serverFile = join(standaloneDir, 'server.js');

if (!existsSync(serverFile)) {
  console.error('No standalone build found. Run `pnpm build` in apps/web first.');
  process.exit(1);
}

cpSync(join(appDir, '.next', 'static'), join(standaloneDir, '.next', 'static'), {
  recursive: true,
});
cpSync(join(appDir, 'public'), join(standaloneDir, 'public'), { recursive: true });

// server.js changes into its own directory and starts listening when it is loaded.
await import(pathToFileURL(serverFile).href);
