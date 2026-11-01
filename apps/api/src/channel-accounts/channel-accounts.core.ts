import { PG, isPgError, schema, type Database } from '@watchtower/db';
import {
  lineWebhookPath,
  type ChannelAccount,
  type CreateChannelAccount,
  type IntegrationStatus,
  type ManagedChannelType,
} from '@watchtower/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

/**
 * Registering and switching off LINE Official Accounts and Gmail mailboxes (T-131). Plain functions
 * over a transaction so the HTTP service and the CLI do the same thing; neither audit nor HTTP
 * lives here.
 */

/** Anything `database.db.transaction` hands out. */
export type Tx = Parameters<Parameters<Database['db']['transaction']>[0]>[0];

export type ChannelAccountErrorCode =
  'line_account_exists' | 'mailbox_exists' | 'not_found' | 'not_managed';

/** A refusal with a stable code and a message that is safe to show (no secret, no mailbox in the message). */
export class ChannelAccountError extends Error {
  constructor(
    readonly code: ChannelAccountErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelAccountError';
  }
}

/** Held while a LINE account is created, so two requests cannot both pass the "only one" check. */
const LINE_CREATE_LOCK = 726_150_131;

export const LINE_SINGLE_ACCOUNT_MESSAGE =
  'This instance already has an active LINE account. It holds one LINE channel secret, so a second ' +
  'account would be checked against the wrong secret. Disable the existing LINE account first.';

export interface AccountRow {
  readonly id: string;
  readonly type: ManagedChannelType;
  readonly name: string;
  readonly health: string;
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
  readonly emailAddress: string | null;
}

const columns = {
  id: schema.channelAccount.id,
  type: schema.channelAccount.type,
  name: schema.channelAccount.name,
  health: schema.channelAccount.health,
  disabledAt: schema.channelAccount.disabledAt,
  createdAt: schema.channelAccount.createdAt,
  emailAddress: schema.gmailAccountState.emailAddress,
};

function asRow(row: {
  id: string;
  type: string;
  name: string;
  health: string;
  disabledAt: Date | null;
  createdAt: Date;
  emailAddress: string | null;
}): AccountRow {
  return { ...row, type: row.type === 'gmail' ? 'gmail' : 'line' };
}

function mailboxExists(): ChannelAccountError {
  return new ChannelAccountError(
    'mailbox_exists',
    'A channel account for this mailbox already exists',
  );
}

export async function createChannelAccount(
  tx: Tx,
  input: CreateChannelAccount,
): Promise<AccountRow> {
  if (input.type === 'line') {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LINE_CREATE_LOCK})`);
    const [existing] = await tx
      .select({ id: schema.channelAccount.id })
      .from(schema.channelAccount)
      .where(and(eq(schema.channelAccount.type, 'line'), isNull(schema.channelAccount.disabledAt)))
      .limit(1);
    if (existing !== undefined) {
      throw new ChannelAccountError('line_account_exists', LINE_SINGLE_ACCOUNT_MESSAGE);
    }
  } else {
    const [taken] = await tx
      .select({ id: schema.gmailAccountState.channelAccountId })
      .from(schema.gmailAccountState)
      .where(eq(schema.gmailAccountState.emailAddress, input.emailAddress))
      .limit(1);
    if (taken !== undefined) throw mailboxExists();
  }
  const [created] = await tx
    .insert(schema.channelAccount)
    .values({ type: input.type, name: input.name })
    .returning({ id: schema.channelAccount.id });
  if (created === undefined) throw new Error('channel account insert returned no row');
  if (input.type === 'gmail') {
    try {
      // A savepoint: losing the race for the address must not abort the caller's transaction.
      await tx.transaction((savepoint) =>
        savepoint.insert(schema.gmailAccountState).values({
          channelAccountId: created.id,
          emailAddress: input.emailAddress,
        }),
      );
    } catch (error) {
      if (isPgError(error, PG.uniqueViolation)) throw mailboxExists();
      throw error;
    }
  }
  const row = await findAccount(tx, created.id);
  if (row === undefined) throw new Error('channel account vanished after insert');
  return row;
}

export async function findAccount(tx: Tx, id: string): Promise<AccountRow | undefined> {
  const [row] = await tx
    .select(columns)
    .from(schema.channelAccount)
    .leftJoin(
      schema.gmailAccountState,
      eq(schema.gmailAccountState.channelAccountId, schema.channelAccount.id),
    )
    .where(eq(schema.channelAccount.id, id))
    .limit(1);
  return row === undefined ? undefined : asRow(row);
}

export async function listAccounts(db: Tx | Database['db']): Promise<AccountRow[]> {
  const rows = await db
    .select(columns)
    .from(schema.channelAccount)
    .leftJoin(
      schema.gmailAccountState,
      eq(schema.gmailAccountState.channelAccountId, schema.channelAccount.id),
    )
    .where(inArray(schema.channelAccount.type, ['line', 'gmail']))
    .orderBy(asc(schema.channelAccount.createdAt), asc(schema.channelAccount.id));
  return rows.map(asRow);
}

/**
 * Switches an account off. Idempotent: `changed` is false when it already was. The row stays
 * (tickets and deliveries reference it); a mailbox also stops syncing.
 */
export async function disableAccount(
  tx: Tx,
  id: string,
  now: Date,
): Promise<{ account: AccountRow; changed: boolean }> {
  const [locked] = await tx
    .select({ type: schema.channelAccount.type, disabledAt: schema.channelAccount.disabledAt })
    .from(schema.channelAccount)
    .where(eq(schema.channelAccount.id, id))
    .for('update');
  if (locked === undefined) throw new ChannelAccountError('not_found', 'No such channel account');
  if (locked.type !== 'line' && locked.type !== 'gmail') {
    throw new ChannelAccountError(
      'not_managed',
      'This kind of channel account is not managed here',
    );
  }
  const changed = locked.disabledAt === null;
  if (changed) {
    await tx
      .update(schema.channelAccount)
      .set({ disabledAt: now, updatedAt: now })
      .where(eq(schema.channelAccount.id, id));
  }
  if (locked.type === 'gmail') {
    await tx
      .update(schema.gmailAccountState)
      .set({ enabled: false, updatedAt: now })
      .where(eq(schema.gmailAccountState.channelAccountId, id));
  }
  const account = await findAccount(tx, id);
  if (account === undefined) throw new Error('channel account vanished');
  return { account, changed };
}

/** The wire shape. `credentials` comes from the credential store's status (never values). */
export function toView(
  row: AccountRow,
  apiUrl: string,
  credentials: ReadonlyMap<ManagedChannelType, IntegrationStatus>,
): ChannelAccount {
  const status = credentials.get(row.type)?.status ?? 'not_configured';
  const enabled = row.disabledAt === null;
  const notes: string[] = [];
  if (!enabled) notes.push('Disabled: it no longer receives or syncs. Its history is kept.');
  if (enabled && status !== 'configured') {
    notes.push(
      `Credentials for ${row.type === 'line' ? 'LINE' : 'Gmail'} are ${status === 'partial' ? 'incomplete' : 'not set'}: ` +
        'save them under integrations (or set the environment variables) before this account can connect.',
    );
  }
  if (row.type === 'line') {
    notes.push(
      'One LINE channel secret per instance: the secret saved under integrations is used for this account.',
    );
  } else {
    notes.push(
      'Gmail credentials are per instance today (service account and mailbox to read), not per mailbox.',
    );
  }
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    health: row.health,
    enabled,
    disabledAt: row.disabledAt === null ? null : row.disabledAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    emailAddress: row.emailAddress,
    webhookUrl: row.type === 'line' ? new URL(lineWebhookPath(row.id), apiUrl).toString() : null,
    credentials: status,
    notes,
  };
}
