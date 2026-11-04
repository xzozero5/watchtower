import type { ObjectStore } from '@watchtower/channels';
import { schema, type Database } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  SCAN_BATCH_SIZE,
  SCAN_MAX_ATTEMPTS,
  STAFF_UPLOAD_ORPHAN_HOURS,
  TICKET_EVENT_TYPES,
} from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';
import { ScanUnavailable, type Clamd } from './clamd.js';

/**
 * The scanning and clean-up work behind the `scan` queue (T-155, ADR-022). Everything is idempotent:
 * a repeated tick, or two overlapping ones, changes nothing twice.
 */

export interface ScannerDeps {
  readonly database: Pick<Database, 'db' | 'pool'>;
  readonly store: ObjectStore;
  readonly logger: Pick<WorkerLogger, 'info' | 'warn' | 'error'>;
  /** Absent when `UPLOAD_SCAN=off`: files are then tracked (if retention needs it) but never scanned. */
  readonly clamd: Clamd | undefined;
  readonly now?: () => Date;
}

const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const ENROL_BATCH = 1000;
/** A tick looks this far back for new files; the daily housekeeping looks at all of them. */
const ENROL_LOOKBACK = "interval '2 days'";

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, attempts), BACKOFF_MAX_MS);
}

/** Text from a stored record that goes into an audit row or a ticket note: no control characters, bounded. */
function tidy(value: string | null, max: number): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

const MESSAGE_LIKE = (table: 'message' | 'inbound_message', source: string, since: string) => `
  INSERT INTO object_scan (object_key, source, ticket_id, filename, size)
  SELECT DISTINCT ON (a ->> 'objectKey')
         a ->> 'objectKey', '${source}', t.ticket_id,
         left(a ->> 'filename', 255),
         CASE WHEN (a ->> 'size') ~ '^[0-9]{1,9}$' THEN (a ->> 'size')::int END
    FROM ${table} t
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(t.attachments) = 'array' THEN t.attachments ELSE '[]'::jsonb END
    ) AS a
   WHERE ${since === 'all' ? 'TRUE' : `t.created_at > now() - ${since}`}
     AND jsonb_typeof(a -> 'objectKey') = 'string'
     AND a ->> 'objectKey' <> ''
     AND NOT EXISTS (SELECT 1 FROM object_scan o WHERE o.object_key = a ->> 'objectKey')
   ORDER BY a ->> 'objectKey'
   LIMIT ${String(ENROL_BATCH)}
  ON CONFLICT (object_key) DO NOTHING`;

/**
 * Gives every stored upload a row in `object_scan`. A tick covers the last two days; `all` also picks
 * up the files that were stored before tracking began (the one-off retroactive scan of ADR-022,
 * decision 4). Returns how many rows were added.
 */
export async function enrol(deps: ScannerDeps, scope: 'recent' | 'all'): Promise<number> {
  const { pool } = deps.database;
  const since = scope === 'all' ? 'all' : ENROL_LOOKBACK;
  let added = 0;
  for (;;) {
    let batch = 0;
    for (const sql of [
      MESSAGE_LIKE('message', 'message', since),
      MESSAGE_LIKE('inbound_message', 'inbound_message', since),
      `INSERT INTO object_scan (object_key, source, filename, size)
       SELECT su.object_key, 'staff_upload', left(su.filename, 255), su.size
         FROM staff_upload su
        WHERE ${scope === 'all' ? 'TRUE' : `su.created_at > now() - ${ENROL_LOOKBACK}`}
          AND NOT EXISTS (SELECT 1 FROM object_scan o WHERE o.object_key = su.object_key)
        ORDER BY su.created_at
        LIMIT ${String(ENROL_BATCH)}
       ON CONFLICT (object_key) DO NOTHING`,
    ]) {
      const result = await pool.query(sql);
      batch += result.rowCount ?? 0;
    }
    added += batch;
    // A tick adds at most one batch; the full pass keeps going until nothing is left to add.
    if (scope === 'recent' || batch === 0) break;
  }
  return added;
}

export interface TickResult {
  readonly enrolled: number;
  readonly clean: number;
  readonly infected: number;
  readonly retried: number;
  readonly failed: number;
}

interface DueRow {
  object_key: string;
  source: string;
  ticket_id: string | null;
  filename: string | null;
  attempts: number;
}

/** Scans the files that are due. Skipped entirely (no clamd) when the mode is off. */
export async function scanDue(deps: ScannerDeps): Promise<Omit<TickResult, 'enrolled'>> {
  const result = { clean: 0, infected: 0, retried: 0, failed: 0 };
  const { clamd } = deps;
  if (clamd === undefined) return result;
  const { pool } = deps.database;
  const due = await pool.query<DueRow>(
    `SELECT object_key, source, ticket_id, filename, attempts
       FROM object_scan
      WHERE scan_status = 'pending' AND next_attempt_at <= now()
      ORDER BY next_attempt_at
      LIMIT $1`,
    [SCAN_BATCH_SIZE],
  );
  for (const row of due.rows) {
    try {
      const bytes = await deps.store.get(row.object_key);
      if (bytes === null) {
        // The object is gone (retention, or removed by hand): nothing to scan or serve. Not retried.
        await pool.query(
          `UPDATE object_scan SET scan_status = 'error', last_error = 'object_missing',
                  attempts = $2, scanned_at = now() WHERE object_key = $1`,
          [row.object_key, SCAN_MAX_ATTEMPTS],
        );
        result.failed += 1;
        continue;
      }
      const verdict = await clamd.scan(bytes);
      if (verdict.kind === 'clean') {
        await pool.query(
          `UPDATE object_scan SET scan_status = 'clean', scanned_at = now(), last_error = NULL
            WHERE object_key = $1 AND scan_status = 'pending'`,
          [row.object_key],
        );
        result.clean += 1;
      } else {
        await markInfected(deps, row, verdict.signature);
        result.infected += 1;
      }
    } catch (error) {
      // clamd down, a store hiccup, a refused stream: never "clean". Back off, and give up for now after
      // SCAN_MAX_ATTEMPTS (the daily housekeeping arms the file again).
      const reason =
        error instanceof ScanUnavailable ? error.message : 'file could not be read or scanned';
      const attempts = row.attempts + 1;
      const exhausted = attempts >= SCAN_MAX_ATTEMPTS;
      await pool.query(
        `UPDATE object_scan
            SET attempts = $2, last_error = $3,
                scan_status = CASE WHEN $4 THEN 'error' ELSE 'pending' END,
                next_attempt_at = now() + ($5::int * interval '1 millisecond')
          WHERE object_key = $1`,
        [row.object_key, attempts, reason.slice(0, 200), exhausted, backoffMs(row.attempts)],
      );
      if (exhausted) {
        result.failed += 1;
        deps.logger.warn({ source: row.source }, 'a file could not be scanned after every retry');
        await pool.query(
          `INSERT INTO audit_log (actor_type, actor_id, action, outcome, target_type, target_id, metadata)
           VALUES ('system', NULL, $1, 'failure', 'upload', $2, $3::jsonb)`,
          [
            AUDIT_ACTIONS.uploadScanFailed,
            row.object_key,
            JSON.stringify({ source: row.source, reason: reason.slice(0, 200) }),
          ],
        );
      } else {
        result.retried += 1;
      }
    }
  }
  return result;
}

/**
 * An infected file: the verdict, the audit row and the ticket note are written in one transaction, then
 * the object is deleted (ADR-022 decision 4). If the delete fails the row keeps `removed_at` empty and
 * `removeInfected` tries again on the next tick; the file is never served meanwhile (status `infected`).
 */
async function markInfected(deps: ScannerDeps, row: DueRow, signature: string): Promise<void> {
  const { db } = deps.database;
  const name = tidy(row.filename, 120);
  await db.transaction(async (tx) => {
    await tx
      .update(schema.objectScan)
      .set({ scanStatus: 'infected', signature, scannedAt: new Date(), lastError: null })
      .where(eq(schema.objectScan.objectKey, row.object_key));
    await tx.insert(schema.auditLog).values({
      actorType: 'system',
      actorId: null,
      action: AUDIT_ACTIONS.uploadScanInfected,
      outcome: 'success',
      targetType: 'upload',
      targetId: row.object_key,
      // The signature name and the file name only: never the content.
      metadata: { source: row.source, signature, filename: name },
    });
    const tickets = new Set<string>();
    if (row.ticket_id !== null) tickets.add(row.ticket_id);
    if (row.source === 'staff_upload') {
      // A staff file is on a ticket through the message that carries a copy of its reference.
      const found = await deps.database.pool.query<{ ticket_id: string }>(
        `SELECT DISTINCT ticket_id FROM message
          WHERE attachments @> jsonb_build_array(jsonb_build_object('objectKey', $1::text))`,
        [row.object_key],
      );
      for (const message of found.rows) tickets.add(message.ticket_id);
    }
    for (const ticketId of tickets) {
      await tx.insert(schema.ticketEvent).values({
        ticketId,
        type: TICKET_EVENT_TYPES.attachmentInfected,
        actorType: 'system',
        actorId: null,
        visibility: 'internal',
        payload: { filename: name, signature },
      });
    }
  });
  await removeInfected(deps, row.object_key);
}

async function removeInfected(deps: ScannerDeps, key: string): Promise<boolean> {
  try {
    await deps.store.delete(key);
  } catch (error) {
    deps.logger.warn(
      { err: error },
      'an infected file could not be deleted yet; it is not served and will be tried again',
    );
    return false;
  }
  await deps.database.pool.query(
    `UPDATE object_scan SET removed_at = now() WHERE object_key = $1 AND removed_at IS NULL`,
    [key],
  );
  return true;
}

/** Deletes the objects of infected files whose delete did not go through the first time. */
export async function retryRemovals(deps: ScannerDeps): Promise<number> {
  const stuck = await deps.database.pool.query<{ object_key: string }>(
    `SELECT object_key FROM object_scan
      WHERE scan_status = 'infected' AND removed_at IS NULL
      ORDER BY scanned_at LIMIT 50`,
  );
  let removed = 0;
  for (const row of stuck.rows) if (await removeInfected(deps, row.object_key)) removed += 1;
  return removed;
}

export interface HousekeepingResult {
  readonly rearmed: number;
  readonly enrolled: number;
  readonly orphans: number;
  readonly expired: number;
}

const ORPHAN_BATCH = 200;
const RETENTION_BATCH = 200;

/**
 * Daily: arms files whose scan gave up, picks up files stored before tracking began, deletes staff
 * uploads nobody attached, and (when `retentionDays` > 0) deletes the files of tickets closed that long.
 */
export async function housekeeping(
  deps: ScannerDeps,
  options: { readonly track: boolean; readonly retentionDays: number },
): Promise<HousekeepingResult> {
  const { pool } = deps.database;
  let rearmed = 0;
  let enrolled = 0;
  if (options.track) {
    enrolled = await enrol(deps, 'all');
    if (deps.clamd !== undefined) {
      const result = await pool.query(
        `UPDATE object_scan SET scan_status = 'pending', attempts = 0, next_attempt_at = now()
          WHERE scan_status = 'error' AND COALESCE(last_error, '') <> 'object_missing'`,
      );
      rearmed = result.rowCount ?? 0;
    }
  }
  const orphans = await sweepOrphanStaffUploads(deps);
  const expired =
    options.retentionDays > 0 ? await expireByRetention(deps, options.retentionDays) : 0;
  if (orphans + expired > 0) {
    await pool.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, outcome, target_type, target_id, metadata)
       VALUES ('system', NULL, $1, 'success', 'upload', NULL, $2::jsonb)`,
      [AUDIT_ACTIONS.uploadSwept, JSON.stringify({ orphans, expired })],
    );
    deps.logger.info({ orphans, expired }, 'upload clean-up deleted files');
  }
  return { rearmed, enrolled, orphans, expired };
}

/**
 * Staff uploads that nothing refers to a day after they were made (the person never sent the note):
 * the row and the object go. "Refers to" = a shift note, a handoff, an incident note or a message that
 * carries the file. The row is deleted first, in one statement that re-checks the references, so a
 * file that was attached a moment ago is not removed.
 */
export async function sweepOrphanStaffUploads(deps: ScannerDeps): Promise<number> {
  const { pool } = deps.database;
  const deleted = await pool.query<{ object_key: string }>(
    `WITH candidates AS (
       SELECT id, object_key, created_at FROM staff_upload su
        WHERE su.created_at < now() - ($1::int * interval '1 hour')
        ORDER BY su.created_at
        LIMIT ${String(ORPHAN_BATCH)}
     )
     DELETE FROM staff_upload su USING candidates c
      WHERE su.id = c.id
        AND NOT EXISTS (SELECT 1 FROM shift_note n
                         WHERE n.attachments @> jsonb_build_array(jsonb_build_object('id', c.id)))
        AND NOT EXISTS (SELECT 1 FROM handoff h
                         WHERE h.attachments @> jsonb_build_array(jsonb_build_object('id', c.id)))
        AND NOT EXISTS (SELECT 1 FROM incident_timeline i
                         WHERE i.payload -> 'attachments'
                               @> jsonb_build_array(jsonb_build_object('id', c.id)))
        AND NOT EXISTS (SELECT 1 FROM message m
                         WHERE m.created_at >= c.created_at
                           AND m.attachments
                               @> jsonb_build_array(jsonb_build_object('objectKey', c.object_key)))
     RETURNING su.object_key`,
    [STAFF_UPLOAD_ORPHAN_HOURS],
  );
  for (const row of deleted.rows) {
    try {
      await deps.store.delete(row.object_key);
    } catch (error) {
      // The row is gone; the object stays until the bucket's own lifecycle rule takes it.
      deps.logger.warn(
        { err: error },
        'an orphaned staff upload could not be deleted from storage',
      );
    }
    await pool.query(`DELETE FROM object_scan WHERE object_key = $1`, [row.object_key]);
  }
  return deleted.rowCount ?? 0;
}

/**
 * Deletes the objects of customer files on tickets that have been closed for `days`. Messages and the
 * audit log stay; the file just stops being available (a download answers 404). Staff uploads are left
 * alone: they can sit on notes and handoffs that have no ticket.
 */
export async function expireByRetention(deps: ScannerDeps, days: number): Promise<number> {
  const { pool } = deps.database;
  const rows = await pool.query<{ object_key: string }>(
    `SELECT o.object_key
       FROM object_scan o
       JOIN ticket t ON t.id = o.ticket_id
      WHERE o.removed_at IS NULL
        AND t.status = 'closed'
        AND t.closed_at IS NOT NULL
        AND t.closed_at < now() - ($1::int * interval '1 day')
        AND NOT EXISTS (SELECT 1 FROM staff_upload su WHERE su.object_key = o.object_key)
      ORDER BY t.closed_at
      LIMIT ${String(RETENTION_BATCH)}`,
    [days],
  );
  let expired = 0;
  for (const row of rows.rows) {
    try {
      await deps.store.delete(row.object_key);
    } catch (error) {
      deps.logger.warn(
        { err: error },
        'an expired file could not be deleted; the next run tries again',
      );
      continue;
    }
    await pool.query(
      `UPDATE object_scan SET removed_at = now() WHERE object_key = $1 AND removed_at IS NULL`,
      [row.object_key],
    );
    expired += 1;
  }
  return expired;
}
