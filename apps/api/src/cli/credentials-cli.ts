import { createCredentialStore, type Database } from '@watchtower/db';
import { AUDIT_ACTIONS, pickCredentialEnv } from '@watchtower/shared';
import { localKmsFromConfig } from '@watchtower/shared/credential-box';

import { AuditService } from '../audit/audit.service.js';
import type { ApiConfig } from '../config/config.js';

export const CREDENTIALS_USAGE = [
  'usage: credentials.js rotate   re-wrap every stored credential under the current APP_ENCRYPTION_KEY_VERSION',
  '       credentials.js status   count stored credentials per key version',
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
  if ((command !== 'rotate' && command !== 'status') || extra.length > 0) {
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

  const result = await store.rotate();
  await new AuditService(database).record({
    actor: { type: 'system', id: 'credentials-cli' },
    action: AUDIT_ACTIONS.integrationCredentialRotate,
    outcome: result.failed.length === 0 ? 'success' : 'failure',
    targetType: 'integration_credential',
    metadata: {
      rewrapped: result.rewrapped,
      alreadyCurrent: result.alreadyCurrent,
      skipped: result.skipped,
      failed: result.failed.length,
      fromVersions: result.fromVersions,
      toVersion: result.toVersion,
    },
  });
  io.out(
    `rotated to key version ${String(result.toVersion)}: ${String(result.rewrapped)} re-wrapped, ${String(result.alreadyCurrent)} already current, ${String(result.skipped)} skipped, ${String(result.failed.length)} failed`,
  );
  for (const failure of result.failed) {
    io.err(`failed: ${failure.integration}.${failure.field} (${failure.reason})`);
  }
  if (result.failed.length > 0) {
    io.err(
      'Some rows could not be opened: keep APP_ENCRYPTION_KEY_PREVIOUS (with its version) set, or enter those values again.',
    );
  }
  return result.failed.length === 0 ? 0 : 1;
}
