import { createCredentialStore, type Database } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  createChannelAccountSchema,
  pickCredentialEnv,
  type IntegrationStatus,
  type ManagedChannelType,
} from '@watchtower/shared';
import { localKmsFromConfig } from '@watchtower/shared/credential-box';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import {
  ChannelAccountError,
  createChannelAccount,
  disableAccount,
  listAccounts,
  toView,
  type AccountRow,
} from '../channel-accounts/channel-accounts.core.js';
import type { ApiConfig } from '../config/config.js';

export const CHANNEL_ACCOUNTS_USAGE = [
  'usage: channel-accounts.js list',
  '       channel-accounts.js create line  --name <name>',
  '       channel-accounts.js create gmail --name <name> --email <mailbox address>',
  '       channel-accounts.js disable <id>',
  'Credentials are saved separately (HTTP /v1/admin/integrations or the environment).',
  'An instance holds one LINE channel secret: a second active LINE account is refused.',
].join('\n');

export interface ChannelAccountsCliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const ACTOR = { type: 'system', id: 'channel-accounts-cli' } as const;

/** `--name x --email y` to a record; null on anything that is not a `--flag value` pair. */
function parseFlags(args: readonly string[]): Record<string, string> | null {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined) return null;
    const key = flag.slice(2);
    if (Object.hasOwn(flags, key)) return null;
    flags[key] = value;
  }
  return flags;
}

function describe(view: ReturnType<typeof toView>, io: ChannelAccountsCliIo): void {
  io.out(
    `${view.id}  ${view.type}  ${view.enabled ? 'enabled' : 'disabled'}  credentials: ${view.credentials}  ${view.name}`,
  );
  if (view.emailAddress !== null) io.out(`  mailbox: ${view.emailAddress}`);
  if (view.webhookUrl !== null)
    io.out(`  webhook URL (paste into the LINE console): ${view.webhookUrl}`);
}

/**
 * `channel-accounts list | create | disable`. Prints ids, names and the webhook URL; never a
 * credential. Returns the exit code: 0 done, 1 refused or failed, 2 bad usage.
 */
export async function runChannelAccountsCli(
  argv: readonly string[],
  config: ApiConfig,
  database: Database,
  io: ChannelAccountsCliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  const store = createCredentialStore({
    database,
    kms: localKmsFromConfig(config),
    env: pickCredentialEnv(config),
  });
  const statuses = async (): Promise<ReadonlyMap<ManagedChannelType, IntegrationStatus>> => {
    const map = new Map<ManagedChannelType, IntegrationStatus>();
    for (const type of ['line', 'gmail'] as const) {
      const [status] = await store.status(type);
      if (status !== undefined) map.set(type, status);
    }
    return map;
  };
  const view = async (row: AccountRow) => toView(row, config.API_URL, await statuses());
  const audit = new AuditService(database);

  if (command === 'list' && rest.length === 0) {
    const rows = await listAccounts(database.db);
    if (rows.length === 0) io.out('no channel accounts');
    for (const row of rows) describe(await view(row), io);
    return 0;
  }

  if (command === 'create') {
    const [type, ...flagArgs] = rest;
    const flags = parseFlags(flagArgs);
    const allowed = type === 'gmail' ? ['name', 'email'] : ['name'];
    if (
      (type !== 'line' && type !== 'gmail') ||
      flags === null ||
      Object.keys(flags).some((key) => !allowed.includes(key))
    ) {
      io.err(CHANNEL_ACCOUNTS_USAGE);
      return 2;
    }
    const parsed = createChannelAccountSchema.safeParse(
      type === 'gmail'
        ? { type, name: flags.name, emailAddress: flags.email }
        : { type, name: flags.name },
    );
    if (!parsed.success) {
      // Field names only: the input may be a mailbox address.
      const fields = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'input')),
      ];
      io.err(`invalid: ${fields.join(', ')}`);
      io.err(CHANNEL_ACCOUNTS_USAGE);
      return 2;
    }
    try {
      const created = await database.db.transaction(async (tx) => {
        const row = await createChannelAccount(tx, parsed.data);
        await audit.recordInTransaction(tx, {
          actor: ACTOR,
          action: AUDIT_ACTIONS.channelAccountCreate,
          targetType: 'channel_account',
          targetId: row.id,
          metadata: { type: row.type },
        });
        return row;
      });
      describe(await view(created), io);
      return 0;
    } catch (error) {
      if (error instanceof ChannelAccountError) {
        io.err(`refused: ${error.message}`);
        return 1;
      }
      throw error;
    }
  }

  if (command === 'disable' && rest.length === 1) {
    const id = z.uuid().safeParse(rest[0]);
    if (!id.success) {
      io.err(CHANNEL_ACCOUNTS_USAGE);
      return 2;
    }
    try {
      const result = await database.db.transaction(async (tx) => {
        const outcome = await disableAccount(tx, id.data, new Date());
        await audit.recordInTransaction(tx, {
          actor: ACTOR,
          action: AUDIT_ACTIONS.channelAccountDisable,
          targetType: 'channel_account',
          targetId: id.data,
          metadata: { type: outcome.account.type, changed: outcome.changed },
        });
        return outcome;
      });
      io.out(result.changed ? 'disabled' : 'already disabled');
      describe(await view(result.account), io);
      return 0;
    } catch (error) {
      if (error instanceof ChannelAccountError) {
        io.err(`refused: ${error.message}`);
        return 1;
      }
      throw error;
    }
  }

  io.err(CHANNEL_ACCOUNTS_USAGE);
  return 2;
}
