import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PG, isPgError } from './errors.js';
import { migrateDown, migrateUp } from './migrator.js';
import { seedShiftDefinitions } from './seed/shifts.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0018 (T-111): shift definitions, roster, clock-in sessions, handoff and its items, shift
// notes, and the two new queue assignment modes. Checks the constraints that keep AC-7's data
// honest in the database itself, the column privileges of the application role, the starter seed
// and the revert.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const INSUFFICIENT_PRIVILEGE = '42501';
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';

let testDb: TestDatabase;
let app: Pool;
const owner = (): Pool => testDb.owner.pool;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
  await owner().query(
    `INSERT INTO users (id, email, name, role) VALUES ($1, 'a@example.com', 'A', 'agent'), ($2, 'b@example.com', 'B', 'agent')`,
    [A, B],
  );
});

afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

async function rejects(work: Promise<unknown>, code: string): Promise<void> {
  try {
    await work;
  } catch (error) {
    expect(isPgError(error, code), String(error)).toBe(true);
    return;
  }
  throw new Error(`expected Postgres error ${code}`);
}

let counter = 0;
const unique = (prefix: string): string => `${prefix} ${String((counter += 1))}`;

async function shift(name = unique('Shift'), starts = '08:00', ends = '17:00'): Promise<string> {
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO shift_definition (name, starts_at, ends_at) VALUES ($1, $2, $3) RETURNING id`,
    [name, starts, ends],
  );
  return rows[0]?.id ?? '';
}

async function session(userId: string, extra = ''): Promise<string> {
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO shift_session (user_id) VALUES ($1) RETURNING id`,
    [userId],
  );
  if (extra !== '') await owner().query(extra, [rows[0]?.id]);
  return rows[0]?.id ?? '';
}

async function ticket(): Promise<string> {
  const org = await owner().query<{ id: string }>(
    `INSERT INTO organization (name) VALUES ($1) RETURNING id`,
    [unique('Org')],
  );
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO ticket (subject, org_id) VALUES ('Help', $1) RETURNING id`,
    [org.rows[0]?.id],
  );
  return rows[0]?.id ?? '';
}

describe('shift_definition', () => {
  it('keeps times as HH:MM and refuses a shift that starts and ends together', async () => {
    await rejects(shift(unique('S'), '8:00', '17:00'), PG.checkViolation);
    await rejects(shift(unique('S'), '08:00', '24:00'), PG.checkViolation);
    await rejects(shift(unique('S'), '08:60', '17:00'), PG.checkViolation);
    await rejects(shift(unique('S'), '08:00', '08:00'), PG.checkViolation);
    await shift(unique('Night'), '22:00', '08:00'); // overnight is fine
  });

  it('keeps names unique regardless of case', async () => {
    const name = unique('Evening');
    await shift(name);
    await rejects(shift(name.toUpperCase()), PG.uniqueViolation);
  });
});

describe('roster_entry', () => {
  it('puts a person on one shift once per date', async () => {
    const id = await shift();
    const insert = () =>
      owner().query(
        `INSERT INTO roster_entry (shift_id, user_id, work_date) VALUES ($1, $2, '2026-11-02')`,
        [id, A],
      );
    await insert();
    await rejects(insert(), PG.uniqueViolation);
    await owner().query(
      `INSERT INTO roster_entry (shift_id, user_id, work_date) VALUES ($1, $2, '2026-11-03')`,
      [id, A],
    );
  });

  it('refuses a shift definition that still has roster entries', async () => {
    const id = await shift();
    await owner().query(
      `INSERT INTO roster_entry (shift_id, user_id, work_date) VALUES ($1, $2, '2026-11-02')`,
      [id, B],
    );
    await rejects(
      owner().query(`DELETE FROM shift_definition WHERE id = $1`, [id]),
      PG.foreignKeyViolation,
    );
  });
});

describe('shift_session', () => {
  it('lets a person be clocked in only once at a time, and again after clocking out', async () => {
    const id = await session(A);
    await rejects(session(A), PG.uniqueViolation);
    await owner().query(`UPDATE shift_session SET clocked_out_at = now() WHERE id = $1`, [id]);
    await session(A);
    await owner().query(
      `UPDATE shift_session SET clocked_out_at = now() WHERE user_id = $1 AND clocked_out_at IS NULL`,
      [A],
    );
  });

  it('cannot clock out before clocking in, or record an override without a clock out or reason', async () => {
    const id = await session(B);
    await rejects(
      owner().query(
        `UPDATE shift_session SET clocked_out_at = clocked_in_at - interval '1 minute' WHERE id = $1`,
        [id],
      ),
      PG.checkViolation,
    );
    await rejects(
      owner().query(`UPDATE shift_session SET override_reason = 'because' WHERE id = $1`, [id]),
      PG.checkViolation,
    );
    await rejects(
      owner().query(
        `UPDATE shift_session SET clocked_out_at = now(), override_reason = '  ' WHERE id = $1`,
        [id],
      ),
      PG.checkViolation,
    );
    await owner().query(
      `UPDATE shift_session SET clocked_out_at = now(), override_by = $2, override_reason = 'lead override' WHERE id = $1`,
      [id, A],
    );
  });

  it('needs both ends of the scheduled window or neither', async () => {
    await rejects(
      owner().query(`INSERT INTO shift_session (user_id, scheduled_start) VALUES ($1, now())`, [A]),
      PG.checkViolation,
    );
  });

  it('lets the application role set the clock out and nothing else of the record', async () => {
    const { rows } = await owner().query<{ id: string }>(
      `INSERT INTO shift_session (user_id) VALUES ($1) RETURNING id`,
      [B],
    );
    const id = rows[0]?.id ?? '';
    await app.query(`UPDATE shift_session SET brief_read_at = now() WHERE id = $1`, [id]);
    await rejects(
      app.query(`UPDATE shift_session SET clocked_in_at = now() - interval '1 day' WHERE id = $1`, [
        id,
      ]),
      INSUFFICIENT_PRIVILEGE,
    );
    await rejects(
      app.query(`UPDATE shift_session SET user_id = $2 WHERE id = $1`, [id, A]),
      INSUFFICIENT_PRIVILEGE,
    );
    await rejects(
      app.query(`DELETE FROM shift_session WHERE id = $1`, [id]),
      INSUFFICIENT_PRIVILEGE,
    );
    await app.query(`UPDATE shift_session SET clocked_out_at = now() WHERE id = $1`, [id]);
  });
});

describe('handoff and its items', () => {
  it('has one handoff per session, and a status that agrees with its confirmation time', async () => {
    const id = await session(A);
    await owner().query(`INSERT INTO handoff (session_id, from_user_id) VALUES ($1, $2)`, [id, A]);
    await rejects(
      owner().query(`INSERT INTO handoff (session_id, from_user_id) VALUES ($1, $2)`, [id, A]),
      PG.uniqueViolation,
    );
    await rejects(
      owner().query(`UPDATE handoff SET status = 'confirmed' WHERE session_id = $1`, [id]),
      PG.checkViolation,
    );
    await rejects(
      owner().query(`UPDATE handoff SET confirmed_at = now() WHERE session_id = $1`, [id]),
      PG.checkViolation,
    );
    await rejects(
      owner().query(`UPDATE handoff SET status = 'sent' WHERE session_id = $1`, [id]),
      PG.checkViolation,
    );
    await rejects(
      owner().query(`UPDATE handoff SET to_user_id = $2 WHERE session_id = $1`, [id, A]),
      PG.checkViolation,
    );
    await owner().query(
      `UPDATE handoff SET status = 'confirmed', confirmed_at = now(), to_user_id = $2 WHERE session_id = $1`,
      [id, B],
    );
    await owner().query(`UPDATE shift_session SET clocked_out_at = now() WHERE id = $1`, [id]);
  });

  it('ties a pending item to a ticket, once per handoff, and keeps an acknowledgment consistent', async () => {
    const sessionId = await session(B);
    const { rows } = await owner().query<{ id: string }>(
      `INSERT INTO handoff (session_id, from_user_id) VALUES ($1, $2) RETURNING id`,
      [sessionId, B],
    );
    const handoff = rows[0]?.id ?? '';
    const ticketId = await ticket();
    const item = (kind: string, ticket: string | null, extra = '') =>
      owner().query(
        `INSERT INTO handoff_item (handoff_id, kind, ticket_id, title, source, requires_ack) VALUES ($1, $2, $3, 'x', 'prefill', true) ${extra}`,
        [handoff, kind, ticket],
      );

    await rejects(item('pending', null), PG.checkViolation);
    await rejects(item('watch', ticketId), PG.checkViolation);
    await rejects(item('bogus', null), PG.checkViolation);
    await item('pending', ticketId);
    await rejects(item('pending', ticketId), PG.uniqueViolation);
    await item('watch', null);

    await rejects(
      owner().query(
        `UPDATE handoff_item SET ack_status = 'accepted' WHERE handoff_id = $1 AND kind = 'pending'`,
        [handoff],
      ),
      PG.checkViolation,
    );
    await rejects(
      owner().query(
        `UPDATE handoff_item SET ack_status = 'maybe', ack_at = now() WHERE handoff_id = $1 AND kind = 'pending'`,
        [handoff],
      ),
      PG.checkViolation,
    );
    // An item that needs no acknowledgment cannot be marked acknowledged.
    await owner().query(
      `UPDATE handoff_item SET requires_ack = false WHERE handoff_id = $1 AND kind = 'watch'`,
      [handoff],
    );
    await rejects(
      owner().query(
        `UPDATE handoff_item SET ack_status = 'accepted', ack_at = now() WHERE handoff_id = $1 AND kind = 'watch'`,
        [handoff],
      ),
      PG.checkViolation,
    );
    await owner().query(
      `UPDATE handoff_item SET ack_status = 'accepted', ack_at = now(), ack_by = $2 WHERE handoff_id = $1 AND kind = 'pending'`,
      [handoff, A],
    );
    await owner().query(`UPDATE shift_session SET clocked_out_at = now() WHERE id = $1`, [
      sessionId,
    ]);
  });

  it('removes the items with their handoff, but never the ticket they point at', async () => {
    const sessionId = await session(A);
    const { rows } = await owner().query<{ id: string }>(
      `INSERT INTO handoff (session_id, from_user_id) VALUES ($1, $2) RETURNING id`,
      [sessionId, A],
    );
    const handoff = rows[0]?.id ?? '';
    const ticketId = await ticket();
    await owner().query(
      `INSERT INTO handoff_item (handoff_id, kind, ticket_id, title, source, requires_ack) VALUES ($1, 'pending', $2, 'x', 'prefill', true)`,
      [handoff, ticketId],
    );
    await rejects(
      owner().query(`DELETE FROM ticket WHERE id = $1`, [ticketId]),
      PG.foreignKeyViolation,
    );
    await owner().query(`DELETE FROM handoff WHERE id = $1`, [handoff]);
    const left = await owner().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM handoff_item WHERE handoff_id = $1`,
      [handoff],
    );
    expect(left.rows[0]?.n).toBe(0);
    await owner().query(`UPDATE shift_session SET clocked_out_at = now() WHERE id = $1`, [
      sessionId,
    ]);
  });
});

describe('shift_note', () => {
  it('needs the recipient its audience names', async () => {
    const insert = (audience: string, to: string | null, at: string | null, body = 'hello') =>
      owner().query(
        `INSERT INTO shift_note (author_id, audience, to_user_id, deliver_at, body) VALUES ($1, $2, $3, $4, $5)`,
        [A, audience, to, at, body],
      );
    await insert('next_shift', null, null);
    await insert('person', B, null);
    await insert('datetime', null, '2026-11-03T01:00:00Z');
    await rejects(insert('person', null, null), PG.checkViolation);
    await rejects(insert('datetime', null, null), PG.checkViolation);
    await rejects(insert('everyone', null, null), PG.checkViolation);
    await rejects(insert('next_shift', null, null, '   '), PG.checkViolation);
  });

  it('is written once: the application role cannot edit the text, and a read is kept per person', async () => {
    const { rows } = await owner().query<{ id: string }>(
      `INSERT INTO shift_note (author_id, audience, body) VALUES ($1, 'next_shift', 'original') RETURNING id`,
      [A],
    );
    const id = rows[0]?.id ?? '';
    await rejects(
      app.query(`UPDATE shift_note SET body = 'changed' WHERE id = $1`, [id]),
      INSUFFICIENT_PRIVILEGE,
    );
    await app.query(`INSERT INTO shift_note_read (note_id, user_id) VALUES ($1, $2)`, [id, B]);
    await rejects(
      app.query(`INSERT INTO shift_note_read (note_id, user_id) VALUES ($1, $2)`, [id, B]),
      PG.uniqueViolation,
    );
    await app.query(`INSERT INTO shift_note_read (note_id, user_id) VALUES ($1, $2)`, [id, A]);
  });
});

describe('team_queue assignment modes', () => {
  it('accepts the two new modes and still refuses an unknown one', async () => {
    for (const mode of ['manual', 'round_robin', 'load_balanced', 'stay_with_last_handler']) {
      await owner().query(`INSERT INTO team_queue (name, assignment_mode) VALUES ($1, $2)`, [
        unique(mode),
        mode,
      ]);
    }
    await rejects(
      owner().query(`INSERT INTO team_queue (name, assignment_mode) VALUES ($1, 'random')`, [
        unique('q'),
      ]),
      PG.checkViolation,
    );
  });
});

describe('the starter seed (owner decision po #7)', () => {
  it('creates 08-17, 13-22 and an on-call 22-08, and leaves an edited shift alone on a second run', async () => {
    const db = testDb.owner;
    const first = await db.db.transaction((tx) => seedShiftDefinitions(tx));
    expect(first.created.toSorted()).toEqual(['Day', 'Evening', 'On-call night']);
    const rows = await owner().query<{
      name: string;
      starts_at: string;
      ends_at: string;
      on_call: boolean;
    }>(
      `SELECT name, starts_at, ends_at, on_call FROM shift_definition WHERE name IN ('Day', 'Evening', 'On-call night') ORDER BY starts_at`,
    );
    expect(rows.rows).toEqual([
      { name: 'Day', starts_at: '08:00', ends_at: '17:00', on_call: false },
      { name: 'Evening', starts_at: '13:00', ends_at: '22:00', on_call: false },
      { name: 'On-call night', starts_at: '22:00', ends_at: '08:00', on_call: true },
    ]);

    await owner().query(`UPDATE shift_definition SET starts_at = '09:00' WHERE name = 'Day'`);
    const second = await db.db.transaction((tx) => seedShiftDefinitions(tx));
    expect(second.created).toEqual([]);
    expect(second.existing).toHaveLength(3);
    const day = await owner().query<{ starts_at: string }>(
      `SELECT starts_at FROM shift_definition WHERE name = 'Day'`,
    );
    expect(day.rows[0]?.starts_at).toBe('09:00');
  });
});

describe('0018 can be reverted', () => {
  it('drops the tables, turns the new queue modes into round_robin, and applies again', async () => {
    await owner().query(
      `INSERT INTO team_queue (name, assignment_mode) VALUES ('Revert LB', 'load_balanced'), ('Revert SL', 'stay_with_last_handler')`,
    );
    const later = await migrationsAfter('0020_shifts');
    const reverted = await migrateDown(owner(), { steps: 1 + later.length });
    expect(reverted).toEqual([...later.toReversed(), '0020_shifts']);

    const gone = await owner().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('shift_definition', 'roster_entry', 'shift_session', 'handoff', 'handoff_item', 'shift_note', 'shift_note_read')`,
    );
    expect(gone.rows[0]?.n).toBe(0);
    const modes = await owner().query<{ name: string; assignment_mode: string }>(
      `SELECT name, assignment_mode FROM team_queue WHERE name LIKE 'Revert %' ORDER BY name`,
    );
    expect(modes.rows.map((row) => row.assignment_mode)).toEqual(['round_robin', 'round_robin']);
    await rejects(
      owner().query(
        `INSERT INTO team_queue (name, assignment_mode) VALUES ('Nope', 'load_balanced')`,
      ),
      PG.checkViolation,
    );

    expect(await migrateUp(owner())).toEqual(['0020_shifts', ...later]);
    const back = await owner().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relname = 'shift_session'`,
    );
    expect(back.rows[0]?.n).toBe(1);
  });
});
