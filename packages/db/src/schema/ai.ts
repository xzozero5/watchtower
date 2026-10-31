// AI runs, drafts and tool executions (T-106, T-108). Empty until the owning task adds its tables (T-123a).
// Mirror the migration by hand (the SQL file is the source of truth) and import shared tables from
// `./ticketing.js` / `./auth.js` as needed. Nothing else needs to change: `./index.ts` already
// re-exports this file.
export {};
