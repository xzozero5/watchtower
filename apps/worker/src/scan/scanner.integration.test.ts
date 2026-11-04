import { randomUUID } from 'node:crypto';

import { createS3ObjectStore, type ObjectStore } from '@watchtower/channels';
import { createDatabase, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { SCAN_MAX_ATTEMPTS } from '@watchtower/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadMailAttachments } from '../outbound/dispatcher.js';
import { createClamd } from './clamd.js';
import { eicar, startFakeClamd, type FakeClamd } from './fake-clamd.js';
import {
  enrol,
  expireByRetention,
  housekeeping,
  retryRemovals,
  scanDue,
  sweepOrphanStaffUploads,
  tidy,
  type ScannerDeps,
} from './scanner.js';
import { readScanVerdict } from './verdict.js';

// T-155 / ADR-022 against a throw-away Postgres and MinIO, with a fake clamd on a TCP port. The EICAR
// string is the harmless industry test file; nothing here is real malware.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let database: Database;
let store: ObjectStore;
let clamd: FakeClamd;
let deps: ScannerDeps;
let userId = '';
let ticketId = '';
const owner = () => testDb.owner.pool;
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const infectedBytes = (): Uint8Array => Buffer.from(`header ${eicar()} trailer`);
const harmless = (): Uint8Array => Buffer.from('plain text of a harmless file');

async function stored(bytes: Uint8Array): Promise<string> {
  const key = `attachments/test/${randomUUID()}`;
  await store.put(key, bytes, 'application/octet-stream');
  return key;
}

async function messageWith(
  keys: readonly string[],
  options: { daysOld?: number } = {},
): Promise<void> {
  const attachments = keys.map((objectKey, index) => ({
    partId: `portal-${String(index + 1)}`,
    filename: `file-${String(index + 1)}.txt`,
    contentType: 'text/plain',
    size: 10,
    objectKey,
  }));
  const message = await owner().query<{ id: string }>(
    `INSERT INTO message (ticket_id, direction, body_text, visibility, attachments)
     VALUES ($1, 'inbound', 'hi', 'public', $2::jsonb) RETURNING id`,
    [ticketId, JSON.stringify(attachments)],
  );
  if (options.daysOld !== undefined) {
    await owner().query(
      `UPDATE message SET created_at = now() - ($2::int * interval '1 day') WHERE id = $1`,
      [message.rows[0]?.id, options.daysOld],
    );
  }
}

async function scanRow(key: string) {
  const result = await owner().query<{
    scan_status: string;
    signature: string | null;
    attempts: number;
    last_error: string | null;
    removed_at: Date | null;
    ticket_id: string | null;
    next_attempt_at: Date;
  }>(`SELECT * FROM object_scan WHERE object_key = $1`, [key]);
  return result.rows[0];
}

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  database = createDatabase({ url: testDb.appUrl, max: 4 });
  store = createS3ObjectStore({
    endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000',
    region: 'us-east-1',
    bucket: 'watchtower',
    accessKey: process.env.TEST_S3_ACCESS_KEY ?? 'minio',
    secretKey: process.env.TEST_S3_SECRET_KEY ?? 'minio12345',
  });
  clamd = await startFakeClamd();
  deps = {
    database,
    store,
    logger,
    clamd: createClamd({ host: '127.0.0.1', port: clamd.port, timeoutMs: 5000 }),
  };
  const user = await owner().query<{ id: string }>(
    `INSERT INTO users (email, name, role) VALUES ('scan@example.com', 'Scan', 'agent') RETURNING id`,
  );
  userId = user.rows[0]?.id ?? '';
  const org = await owner().query<{ id: string }>(
    `INSERT INTO organization (name) VALUES ('Example Org') RETURNING id`,
  );
  const ticket = await owner().query<{ id: string }>(
    `INSERT INTO ticket (subject, org_id) VALUES ('Attachment', $1) RETURNING id`,
    [org.rows[0]?.id],
  );
  ticketId = ticket.rows[0]?.id ?? '';
});

afterEach(async () => {
  await owner().query('DELETE FROM object_scan');
  await owner().query('DELETE FROM message');
  await owner().query('DELETE FROM inbound_message');
  await owner().query('DELETE FROM inbound_event');
});

/** A mail that came in: the raw payload, one attachment, the event and the message rows. */
async function inboundMail(
  attachmentBytes: Uint8Array,
  options: { closedDaysAgo?: number } = {},
): Promise<{ attachmentKey: string; rawKey: string; eventRawKey: string }> {
  const attachmentKey = await stored(attachmentBytes);
  const rawKey = await stored(Buffer.from('From: x\r\n\r\nraw message with the attachment inside'));
  const eventRawKey = await stored(Buffer.from('raw event payload'));
  const account = await owner().query<{ id: string }>(
    `INSERT INTO channel_account (type, name) VALUES ('gmail', $1) RETURNING id`,
    [`Support ${randomUUID()}`],
  );
  const accountId = account.rows[0]?.id;
  const event = await owner().query<{ id: string }>(
    `INSERT INTO inbound_event (channel_account_id, provider_event_id, raw_object_key)
     VALUES ($1, $2, $3) RETURNING id`,
    [accountId, randomUUID(), eventRawKey],
  );
  await owner().query(
    `INSERT INTO inbound_message
       (channel_account_id, inbound_event_id, provider_message_id, received_at, raw_object_key, ticket_id, attachments, disposition)
     VALUES ($1, $2, $3, now(), $4, $5, $6::jsonb, 'ticket')`,
    [
      accountId,
      event.rows[0]?.id,
      randomUUID(),
      rawKey,
      ticketId,
      JSON.stringify([
        {
          partId: '1',
          filename: 'a.zip',
          contentType: 'application/zip',
          size: 10,
          objectKey: attachmentKey,
        },
      ]),
    ],
  );
  if (options.closedDaysAgo !== undefined) {
    await owner().query(
      `UPDATE ticket SET status = 'closed', closed_at = now() - ($2::int * interval '1 day') WHERE id = $1`,
      [ticketId, options.closedDaysAgo],
    );
  }
  return { attachmentKey, rawKey, eventRawKey };
}

afterAll(async () => {
  await clamd.close();
  await database.close();
  await testDb.cleanup();
});

describe('enrolment and the scan', () => {
  it('enrols new files, marks harmless ones clean, and tells the gate so', async () => {
    const key = await stored(harmless());
    await messageWith([key]);
    expect(await enrol(deps, 'recent')).toBe(1);
    expect((await scanRow(key))?.scan_status).toBe('pending');
    // Not clean until scanned: this is what the api and the mail dispatcher see.
    expect(await readScanVerdict(database, key)).toBe('pending');

    const result = await scanDue(deps);
    expect(result).toMatchObject({ clean: 1, infected: 0 });
    expect((await scanRow(key))?.scan_status).toBe('clean');
    expect(await readScanVerdict(database, key)).toBe('clean');
    // A second tick finds nothing new and does not scan again.
    expect(await enrol(deps, 'recent')).toBe(0);
    expect(await scanDue(deps)).toMatchObject({ clean: 0 });
  });

  it('removes an infected file: object deleted, audited, noted on the ticket, never "clean"', async () => {
    const key = await stored(infectedBytes());
    await messageWith([key]);
    await enrol(deps, 'recent');
    expect(await scanDue(deps)).toMatchObject({ infected: 1, clean: 0 });

    const row = await scanRow(key);
    expect(row?.scan_status).toBe('infected');
    expect(row?.signature).toBe('Win.Test.EICAR_HDB-1');
    expect(row?.removed_at).not.toBeNull();
    expect(await store.get(key)).toBeNull();
    expect(await readScanVerdict(database, key)).toBe('infected');

    const audit = await owner().query<{
      actor_type: string;
      outcome: string;
      target_id: string;
      metadata: unknown;
    }>(
      `SELECT actor_type, outcome, target_id, metadata FROM audit_log WHERE action = 'upload.scan_infected' AND target_id = $1`,
      [key],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_type: 'system', outcome: 'success' });
    expect(JSON.stringify(audit.rows[0]?.metadata)).toContain('Win.Test.EICAR_HDB-1');
    // The content never goes into the log.
    expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain('EICAR-STANDARD');

    const events = await owner().query<{ visibility: string; payload: unknown }>(
      `SELECT visibility, payload FROM ticket_event WHERE ticket_id = $1 AND type = 'ticket.attachment_infected'`,
      [ticketId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.visibility).toBe('internal');
    expect(events.rows[0]?.payload).toMatchObject({ signature: 'Win.Test.EICAR_HDB-1' });
  });

  it('finishes deleting an infected file whose delete failed the first time', async () => {
    const key = await stored(infectedBytes());
    await messageWith([key]);
    await enrol(deps, 'recent');
    let failDeletes = true;
    const flaky: ObjectStore = {
      put: (k, b, t) => store.put(k, b, t),
      get: (k) => store.get(k),
      getStream: (k) => store.getStream(k),
      delete: (k) => (failDeletes ? Promise.reject(new Error('storage outage')) : store.delete(k)),
    };
    await scanDue({ ...deps, store: flaky });
    const first = await scanRow(key);
    expect(first?.scan_status).toBe('infected');
    expect(first?.removed_at).toBeNull();
    expect(await readScanVerdict(database, key)).toBe('infected');
    failDeletes = false;
    expect(await retryRemovals({ ...deps, store: flaky })).toBe(1);
    expect((await scanRow(key))?.removed_at).not.toBeNull();
    expect(await store.get(key)).toBeNull();
  });

  it('keeps a file pending, with backoff, while the scanner cannot answer; gives up as error, never clean', async () => {
    const broken = await startFakeClamd('garbage');
    try {
      const key = await stored(harmless());
      await messageWith([key]);
      await enrol(deps, 'recent');
      const brokenDeps = {
        ...deps,
        clamd: createClamd({ host: '127.0.0.1', port: broken.port, timeoutMs: 2000 }),
      };
      expect(await scanDue(brokenDeps)).toMatchObject({ retried: 1, clean: 0 });
      const waiting = await scanRow(key);
      expect(waiting?.scan_status).toBe('pending');
      expect(waiting?.attempts).toBe(1);
      expect(waiting?.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
      expect(await readScanVerdict(database, key)).toBe('pending');
      // Backoff: not due again yet.
      expect(await scanDue(brokenDeps)).toMatchObject({ retried: 0, clean: 0 });

      // Last attempt.
      await owner().query(
        `UPDATE object_scan SET attempts = $2, next_attempt_at = now() WHERE object_key = $1`,
        [key, SCAN_MAX_ATTEMPTS - 1],
      );
      expect(await scanDue(brokenDeps)).toMatchObject({ failed: 1 });
      expect((await scanRow(key))?.scan_status).toBe('error');
      expect(await readScanVerdict(database, key)).toBe('pending');
      const audit = await owner().query(
        `SELECT 1 FROM audit_log WHERE action = 'upload.scan_failed' AND target_id = $1`,
        [key],
      );
      expect(audit.rowCount).toBe(1);

      // The daily housekeeping arms it again, and with a working scanner it is checked.
      const result = await housekeeping(deps, { track: true, retentionDays: 0 });
      expect(result.rearmed).toBe(1);
      expect(await scanDue(deps)).toMatchObject({ clean: 1 });
    } finally {
      await broken.close();
    }
  });

  it('scans files stored before tracking began, once (the retroactive scan)', async () => {
    const key = await stored(harmless());
    await messageWith([key], { daysOld: 40 });
    expect(await enrol(deps, 'recent')).toBe(0);
    expect(await enrol(deps, 'all')).toBe(1);
    expect(await enrol(deps, 'all')).toBe(0);
    expect(await scanDue(deps)).toMatchObject({ clean: 1 });
  });

  it('enrols staff uploads and the ticket that carries a copy of one gets the infected note', async () => {
    const key = await stored(infectedBytes());
    await owner().query(
      `INSERT INTO staff_upload (uploader_id, object_key, filename, content_type, size, sha256)
       VALUES ($1, $2, 'shot.png', 'image/png', 30, 'abc')`,
      [userId, key],
    );
    await messageWith([key]);
    await enrol(deps, 'recent');
    await scanDue(deps);
    const events = await owner().query(
      `SELECT 1 FROM ticket_event WHERE ticket_id = $1 AND type = 'ticket.attachment_infected'`,
      [ticketId],
    );
    expect(events.rowCount).toBeGreaterThanOrEqual(1);
    await owner().query(`DELETE FROM staff_upload WHERE object_key = $1`, [key]);
  });
});

describe('what mail may attach', () => {
  it('sends only clean files; waits for a pending one; refuses an infected one', async () => {
    const objects = {
      get: () => Promise.resolve(Buffer.from('x')),
    } as unknown as ObjectStore;
    const record = (name: string) => [{ objectKey: name, filename: `${name}.txt` }];
    const verdicts = {
      ok: 'clean',
      wait: 'pending',
      bad: 'infected',
    } as const;
    const status = (key: string) => Promise.resolve(verdicts[key as keyof typeof verdicts]);
    expect(await loadMailAttachments(objects, record('ok'), logger as never, status)).toHaveLength(
      1,
    );
    await expect(
      loadMailAttachments(objects, record('wait'), logger as never, status),
    ).rejects.toMatchObject({ transient: true });
    await expect(
      loadMailAttachments(objects, record('bad'), logger as never, status),
    ).rejects.toMatchObject({ transient: false });
    // With the scan off nothing is asked.
    expect(await loadMailAttachments(objects, record('wait'), logger as never)).toHaveLength(1);
  });
});

describe('orphans and retention', () => {
  it('deletes a staff upload nobody attached after a day, and keeps the ones in use', async () => {
    const make = async (hoursOld: number): Promise<{ id: string; key: string }> => {
      const key = await stored(harmless());
      const row = await owner().query<{ id: string }>(
        `INSERT INTO staff_upload (uploader_id, object_key, filename, content_type, size, sha256, created_at)
         VALUES ($1, $2, 'a.txt', 'text/plain', 29, 'abc', now() - ($3::int * interval '1 hour')) RETURNING id`,
        [userId, key, hoursOld],
      );
      return { id: row.rows[0]?.id ?? '', key };
    };
    const orphan = await make(30);
    const fresh = await make(1);
    const onNote = await make(30);
    const onMessage = await make(30);
    await owner().query(
      `INSERT INTO shift_note (author_id, audience, body, attachments)
       VALUES ($1, 'next_shift', 'n', $2::jsonb)`,
      [userId, JSON.stringify([{ id: onNote.id, filename: 'a.txt' }])],
    );
    await messageWith([onMessage.key]);

    expect(await sweepOrphanStaffUploads(deps)).toBe(1);
    expect(await store.get(orphan.key)).toBeNull();
    for (const kept of [fresh, onNote, onMessage]) {
      expect(await store.get(kept.key)).not.toBeNull();
      const row = await owner().query(`SELECT 1 FROM staff_upload WHERE id = $1`, [kept.id]);
      expect(row.rowCount).toBe(1);
    }
    await owner().query(`DELETE FROM shift_note`);
    await owner().query(`DELETE FROM staff_upload`);
  });

  it('deletes the files of a ticket closed longer than the retention, and nothing else', async () => {
    const old = await stored(harmless());
    await messageWith([old]);
    await enrol(deps, 'recent');
    expect(await expireByRetention(deps, 30)).toBe(0); // the ticket is not closed
    await owner().query(
      `UPDATE ticket SET status = 'closed', closed_at = now() - interval '45 days' WHERE id = $1`,
      [ticketId],
    );
    expect(await expireByRetention(deps, 60)).toBe(0); // closed, but not that long
    expect(await expireByRetention(deps, 30)).toBe(1);
    expect(await store.get(old)).toBeNull();
    expect((await scanRow(old))?.removed_at).not.toBeNull();
    expect(await expireByRetention(deps, 30)).toBe(0); // once
    await owner().query(`UPDATE ticket SET status = 'new', closed_at = NULL WHERE id = $1`, [
      ticketId,
    ]);
  });
});

describe('raw mail of an infected attachment (T-155a C-3)', () => {
  it('deletes the raw message and the raw event along with the infected file, and forgets their keys', async () => {
    const mail = await inboundMail(infectedBytes());
    await enrol(deps, 'recent');
    expect(await scanDue(deps)).toMatchObject({ infected: 1 });
    expect(await store.get(mail.attachmentKey)).toBeNull();
    expect(await store.get(mail.rawKey)).toBeNull();
    expect(await store.get(mail.eventRawKey)).toBeNull();
    const rows = await owner().query<{ raw_object_key: string | null }>(
      `SELECT raw_object_key FROM inbound_message UNION ALL SELECT raw_object_key FROM inbound_event`,
    );
    expect(rows.rows.map((row) => row.raw_object_key)).toEqual([null, null]);
    expect((await scanRow(mail.attachmentKey))?.removed_at).not.toBeNull();
  });

  it('keeps the raw message of a clean attachment', async () => {
    const mail = await inboundMail(harmless());
    await enrol(deps, 'recent');
    expect(await scanDue(deps)).toMatchObject({ clean: 1, infected: 0 });
    expect(await store.get(mail.rawKey)).not.toBeNull();
  });

  it('does not call the file removed while the raw message is still there (it is tried again)', async () => {
    const mail = await inboundMail(infectedBytes());
    await enrol(deps, 'recent');
    const failing = {
      get: (key: string) => store.get(key),
      put: (...args: Parameters<ObjectStore['put']>) => store.put(...args),
      delete: (key: string) =>
        key === mail.rawKey ? Promise.reject(new Error('storage down')) : store.delete(key),
    } as unknown as ObjectStore;
    await scanDue({ ...deps, store: failing });
    const first = await scanRow(mail.attachmentKey);
    expect(first?.scan_status).toBe('infected');
    expect(first?.removed_at).toBeNull();
    expect(await retryRemovals(deps)).toBe(1);
    expect(await store.get(mail.rawKey)).toBeNull();
    expect(await store.get(mail.attachmentKey)).toBeNull();
  });

  it('retention covers the raw message and the raw event of a ticket closed long enough', async () => {
    const mail = await inboundMail(harmless(), { closedDaysAgo: 45 });
    try {
      expect(await expireByRetention(deps, 60)).toBe(0);
      expect(await store.get(mail.rawKey)).not.toBeNull();
      await enrol(deps, 'recent');
      // the attachment, the raw message and the raw event
      expect(await expireByRetention(deps, 30)).toBe(3);
      expect(await store.get(mail.rawKey)).toBeNull();
      expect(await store.get(mail.eventRawKey)).toBeNull();
      expect(await expireByRetention(deps, 30)).toBe(0);
    } finally {
      await owner().query(`UPDATE ticket SET status = 'new', closed_at = NULL WHERE id = $1`, [
        ticketId,
      ]);
    }
  });
});

describe('text that goes into an audit row (T-155a C-8)', () => {
  it('drops bidi overrides, zero-width and line-separator characters as well as control characters', () => {
    const name = 'invoice‮gpj.exe​ ﻿\u0007x';
    expect(tidy(name, 120)).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(tidy(name, 120)).toContain('invoice');
    expect(tidy(null, 10)).toBe('');
  });
});

describe('the orphan sweep and a file being attached (T-155a C-9)', () => {
  it('skips a staff upload that a transaction is attaching (shared advisory lock), and takes it once that has ended', async () => {
    const key = await stored(harmless());
    const row = await owner().query<{ id: string }>(
      `INSERT INTO staff_upload (uploader_id, object_key, filename, content_type, size, sha256, created_at)
       VALUES ($1, $2, 'a.txt', 'text/plain', 29, 'abc', now() - interval '30 hours') RETURNING id`,
      [userId, key],
    );
    const id = row.rows[0]?.id;
    const claimer = await owner().connect();
    try {
      await claimer.query('BEGIN');
      // What StaffUploadsService.claim does inside the transaction that saves the note.
      await claimer.query(
        `SELECT pg_advisory_xact_lock_shared(hashtextextended('staff_upload:' || $1::text, 0))`,
        [id],
      );
      // Without the lock check the sweep would delete a file that is being attached.
      expect(await sweepOrphanStaffUploads(deps)).toBe(0);
      expect(await store.get(key)).not.toBeNull();
      await claimer.query('COMMIT');
    } finally {
      claimer.release();
    }
    expect(await sweepOrphanStaffUploads(deps)).toBe(1);
    expect(await store.get(key)).toBeNull();
  });

  it('keeps a file a message already carries', async () => {
    const key = await stored(harmless());
    await owner().query(
      `INSERT INTO staff_upload (uploader_id, object_key, filename, content_type, size, sha256, created_at)
       VALUES ($1, $2, 'a.txt', 'text/plain', 29, 'abc', now() - interval '30 hours')`,
      [userId, key],
    );
    await messageWith([key]);
    expect(await sweepOrphanStaffUploads(deps)).toBe(0);
    expect(await store.get(key)).not.toBeNull();
    await owner().query(`DELETE FROM staff_upload`);
  });
});

describe('an encrypted archive (T-155a C-2)', () => {
  it('is infected, removed and recorded as the clamd heuristic, not clean', async () => {
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x01, 0x00]),
      Buffer.from('password protected'),
    ]);
    const key = await stored(zip);
    await messageWith([key]);
    await enrol(deps, 'recent');
    expect(await scanDue(deps)).toMatchObject({ infected: 1, clean: 0 });
    const row = await scanRow(key);
    expect(row?.scan_status).toBe('infected');
    expect(row?.signature).toBe('Heuristics.Encrypted.Zip');
    expect(await store.get(key)).toBeNull();
  });
});

describe('two scans of the same file at once (queue concurrency is 1 per worker process)', () => {
  it('writes one audit row and one ticket note, not two', async () => {
    const key = await stored(infectedBytes());
    await messageWith([key]);
    await enrol(deps, 'recent');
    const before = await owner().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ticket_event WHERE ticket_id = $1 AND type = 'ticket.attachment_infected'`,
      [ticketId],
    );
    await Promise.all([scanDue(deps), scanDue(deps)]);
    const audit = await owner().query(
      `SELECT 1 FROM audit_log WHERE action = 'upload.scan_infected' AND target_id = $1`,
      [key],
    );
    expect(audit.rowCount).toBe(1);
    const notes = await owner().query(
      `SELECT 1 FROM ticket_event WHERE ticket_id = $1 AND type = 'ticket.attachment_infected'`,
      [ticketId],
    );
    expect(notes.rowCount).toBe(Number(before.rows[0]?.n) + 1);
  });
});
