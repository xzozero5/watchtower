// Entry point for `pnpm kb:reembed` (ADR-033 §7).
import { createDatabase } from './client.js';
import { KbReembedError, requestKbReembed } from './kb-reembed.js';

const USAGE =
  'usage: kb-reembed-cli.js --actor <email|userId> [--reason <text>]\n' +
  '  Enqueues a reembed_all job in the transactional outbox and records an audit log row.\n' +
  '  Actor must be an active user with KB/AI administration privileges (e.g. head, lead).\n' +
  '  MIGRATION_DATABASE_URL (or DATABASE_URL) must be set.';

interface ParsedArgs {
  readonly actor: string;
  readonly reason?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs | null {
  let actor: string | undefined;
  let reason: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || arg === '--') continue;

    if (arg === '--actor') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) return null;
      actor = next;
      index += 1;
    } else if (arg.startsWith('--actor=')) {
      const value = arg.slice('--actor='.length);
      if (!value) return null;
      actor = value;
    } else if (arg === '--reason') {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) return null;
      reason = next;
      index += 1;
    } else if (arg.startsWith('--reason=')) {
      reason = arg.slice('--reason='.length);
    } else {
      // Unrecognized flag or positional argument
      return null;
    }
  }

  if (!actor) return null;
  return { actor, reason };
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed) {
    console.error(USAGE);
    return 2;
  }

  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error(`MIGRATION_DATABASE_URL or DATABASE_URL is not set.\n${USAGE}`);
    return 2;
  }

  try {
    const database = createDatabase({ url, max: 2, applicationName: 'watchtower-kb-reembed' });
    try {
      const result = await requestKbReembed(database, {
        actor: parsed.actor,
        reason: parsed.reason,
      });

      console.log(`kb:reembed requestId=${result.requestId} status=${result.status}`);
      return 0;
    } finally {
      await database.close();
    }
  } catch (error) {
    const label = error instanceof KbReembedError ? 'kb:reembed refused' : 'kb:reembed failed';
    console.error(`${label}: ${error instanceof Error ? error.message : 'unknown error'}`);
    return 1;
  }
}

// Only run main if executed as a script
if (
  process.argv[1]?.endsWith('kb-reembed-cli.js') ||
  process.argv[1]?.endsWith('kb-reembed-cli.ts')
) {
  process.exitCode = await main(process.argv.slice(2));
}
