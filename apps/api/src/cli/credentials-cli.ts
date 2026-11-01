import { createCredentialStore, type Database } from '@watchtower/db';
import { AUDIT_ACTIONS, pickCredentialEnv } from '@watchtower/shared';
import { localKmsFromConfig } from '@watchtower/shared/credential-box';

import { AuditService } from '../audit/audit.service.js';
import type { ApiConfig } from '../config/config.js';

export const CREDENTIALS_USAGE = [
  'usage: credentials.js rotate            re-wrap every data key under the current APP_ENCRYPTION_KEY_VERSION',
  '       credentials.js rotate --reseal   also generate new data keys and re-seal every value',
  '       credentials.js status            count stored credentials per key version',
  'Neither helps once a value itself has leaked: change it at the provider and enter it again.',
].join('\n');

export interface CredentialsCliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/**
 * `credentials rotate` and `credentials status` (ADR-012). Prints counts and field names, never a
 * value or a key. Returns the exit code: 0 done, 1 some rows could not be opened, 2 bad usage.
 */
export async function runCredentialsCli(
  argv: readonly string[],
  config: ApiConfig,
  database: Database,
  io: CredentialsCliIo,
): Promise<number> {
  const [command, ...extra] = argv;
  const reseal = command === 'rotate' && extra.length === 1 && extra[0] === '--reseal';
  if ((command !== 'rotate' && command !== 'status') || (extra.length > 0 && !reseal)) {
    io.err(CREDENTIALS_USAGE);
    return 2;
  }
  const store = createCredentialStore({
    database,
    kms: localKmsFromConfig(config),
    env: pickCredentialEnv(config),
  });

  if (command === 'status') {
    const counts = await store.versionCounts();
    io.out(`current key version: ${String(store.currentKeyVersion)}`);
    if (counts.length === 0) io.out('no stored credentials');
    for (const { keyVersion, rows } of counts) {
      io.out(
        `key version ${String(keyVersion)}: ${String(rows)} row(s)${keyVersion === store.currentKeyVersion ? ' (current)' : ' (needs rotate)'}`,
      );
    }
    return 0;
  }

  // The audit row is written whatever happens: a run that stops half way says how far it got.
  let done = 0;
  let failures: number;
  let outcome: 'success' | 'failure' = 'failure';
  let summary: Record<string, unknown> = {};
  try {
    if (reseal) {
      const result = await store.reseal({
        onRow: () => {
          done += 1;
        },
      });
      failures = result.failed.length;
      summary = {
        mode: 'reseal',
        resealed: result.resealed,
        skipped: result.skipped,
        failed: result.failed.length,
        toVersion: result.toVersion,
      };
      io.out(
        `re-sealed under key version ${String(result.toVersion)}: ${String(result.resealed)} re-sealed, ${String(result.skipped)} skipped, ${String(result.failed.length)} failed`,
      );
      reportFailures(result.failed, io);
    } else {
      const result = await store.rotate({
        onRow: () => {
          done += 1;
        },
      });
      failures = result.failed.length;
      summary = {
        mode: 'rewrap',
        rewrapped: result.rewrapped,
        alreadyCurrent: result.alreadyCurrent,
        skipped: result.skipped,
        failed: result.failed.length,
        fromVersions: result.fromVersions,
        toVersion: result.toVersion,
      };
      io.out(
        `rotated to key version ${String(result.toVersion)}: ${String(result.rewrapped)} re-wrapped, ${String(result.alreadyCurrent)} already current, ${String(result.skipped)} skipped, ${String(result.failed.length)} failed`,
      );
      reportFailures(result.failed, io);
    }
    outcome = failures === 0 ? 'success' : 'failure';
    return failures === 0 ? 0 : 1;
  } finally {
    await new AuditService(database).record({
      actor: { type: 'system', id: 'credentials-cli' },
      action: AUDIT_ACTIONS.integrationCredentialRotate,
      outcome,
      targetType: 'integration_credential',
      metadata:
        Object.keys(summary).length > 0
          ? summary
          : { mode: reseal ? 'reseal' : 'rewrap', aborted: true, rowsDone: done },
    });
  }
}

function reportFailures(
  failed: readonly { integration: string; field: string; reason: string }[],
  io: CredentialsCliIo,
): void {
  for (const failure of failed) {
    io.err(`failed: ${failure.integration}.${failure.field} (${failure.reason})`);
  }
  if (failed.length > 0) {
    io.err(
      'Some rows could not be opened: keep APP_ENCRYPTION_KEY_PREVIOUS (with its version) set, or enter those values again.',
    );
  }
}
