import { randomBytes } from 'node:crypto';

import type {
  ManualTicketResult,
  PortalSubmitted,
  StaffAttachment,
  TimelineEntry,
  UploadScanSummary,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { solveChallenge } from '../portal/pow.js';
import { startHarness, uniqueEmail, type Harness } from '../testing/harness.js';
import { apiOrg, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';

// T-155 / ADR-022: what the api does with the verdicts of the malware scan, the admin notice, the
// portal's daily cap and the streamed download. The scanning itself is the worker's (its own test).

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
  Buffer.alloc(4),
  Buffer.from([0, 0, 0, 32]),
  Buffer.from('IDAT'),
  randomBytes(32),
  Buffer.alloc(4),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('IEND'),
  Buffer.alloc(4),
]);

let on: Harness;
let off: Harness;
let agent: Persona;
let lead: Persona;
let head: Persona;
let orgId: string;

beforeAll(async () => {
  on = await startHarness({
    env: {
      UPLOAD_SCAN: 'clamav',
      PORTAL_POW_DIFFICULTY_BITS: '8',
      PORTAL_MIN_FILL_SECONDS: '0',
      PORTAL_UPLOAD_DAILY_MB: '1',
    },
  });
  off = await startHarness();
  agent = await signIn(on, 'agent');
  lead = await signIn(on, 'lead');
  head = await signIn(on, 'head');
  orgId = (await apiOrg(lead, { name: 'Scan Org' })).id;
});

afterAll(async () => {
  await on.close();
  await off.close();
});

function form(name: string, bytes: Uint8Array): FormData {
  const data = new FormData();
  data.append('file', new Blob([Buffer.from(bytes)]), name);
  return data;
}

async function setStatus(h: Harness, id: string, status: string | null): Promise<void> {
  const row = await h.db.owner.pool.query<{ object_key: string }>(
    `SELECT object_key FROM staff_upload WHERE id = $1`,
    [id],
  );
  const key = row.rows[0]?.object_key ?? '';
  await h.db.owner.pool.query(`DELETE FROM object_scan WHERE object_key = $1`, [key]);
  if (status !== null) {
    await h.db.owner.pool.query(
      `INSERT INTO object_scan (object_key, source, scan_status) VALUES ($1, 'staff_upload', $2)`,
      [key, status],
    );
  }
}

describe('UPLOAD_SCAN=clamav: a file is served only when it is clean', () => {
  it('answers 409 scan_pending until the worker says clean, then streams the same bytes', async () => {
    const uploaded = await agent.client.post<StaffAttachment & ApiErrorBody>(
      '/v1/uploads',
      form('shot.png', PNG),
    );
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    const id = uploaded.body.id;

    // No scan row yet: not clean, so not served (fail closed).
    const early = await agent.client.get<ApiErrorBody>(`/v1/uploads/${id}`);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('scan_pending');

    await setStatus(on, id, 'pending');
    expect((await agent.client.get<ApiErrorBody>(`/v1/uploads/${id}`)).status).toBe(409);
    await setStatus(on, id, 'error');
    expect((await agent.client.get<ApiErrorBody>(`/v1/uploads/${id}`)).status).toBe(409);

    await setStatus(on, id, 'infected');
    const gone = await agent.client.get<ApiErrorBody>(`/v1/uploads/${id}`);
    expect(gone.status).toBe(410);
    expect(gone.body.code).toBe('file_infected');

    await setStatus(on, id, 'clean');
    const file = await agent.client.get(`/v1/uploads/${id}`);
    expect(file.status).toBe(200);
    expect(Buffer.from(file.bytes).equals(PNG)).toBe(true);
    expect(file.headers.get('content-length')).toBe(String(PNG.length));
    expect(file.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it("gates the ticket download too, and tells staff each file's state on the timeline", async () => {
    const mine = await agent.client.post<StaffAttachment>('/v1/uploads', form('err.png', PNG));
    const created = await agent.client.post<ManualTicketResult>('/v1/tickets/manual', {
      orgId,
      channel: 'phone',
      subject: 'Screenshot from the call',
      body: 'The customer sent a screenshot.',
      requester: { email: uniqueEmail('caller', 'customer.example'), name: 'Caller' },
      attachmentIds: [mine.body.id],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const ticketId = created.body.ticket.id;
    const message = await on.db.owner.pool.query<{ id: string }>(
      `SELECT id FROM message WHERE ticket_id = $1`,
      [ticketId],
    );
    const url = `/v1/tickets/${created.body.ticket.key}/messages/${message.rows[0]?.id ?? ''}/attachments/0`;
    const timeline = async (who: Persona): Promise<Record<string, unknown>[]> => {
      const response = await who.client.get<{ entries: TimelineEntry[] }>(
        `/v1/tickets/${created.body.ticket.key}/timeline`,
      );
      const entry = response.body.entries.find((item) => item.kind === 'message');
      return (entry as { attachments?: Record<string, unknown>[] }).attachments ?? [];
    };

    expect((await agent.client.get<ApiErrorBody>(url)).status).toBe(409);
    expect((await timeline(agent))[0]?.scanState).toBe('pending');

    await setStatus(on, mine.body.id, 'clean');
    expect((await agent.client.get(url)).status).toBe(200);
    expect((await timeline(agent))[0]?.scanState).toBe('clean');

    await setStatus(on, mine.body.id, 'infected');
    expect((await agent.client.get<ApiErrorBody>(url)).status).toBe(410);
    expect((await timeline(agent))[0]?.scanState).toBe('infected');
  });
});

describe('UPLOAD_SCAN=off: as before, with a notice for the admin', () => {
  it('serves a file at once and says nothing about scan state', async () => {
    const who = await signIn(off, 'agent');
    const uploaded = await who.client.post<StaffAttachment>('/v1/uploads', form('a.png', PNG));
    const file = await who.client.get(`/v1/uploads/${uploaded.body.id}`);
    expect(file.status).toBe(200);
    expect(Buffer.from(file.bytes).equals(PNG)).toBe(true);
  });

  it('GET /v1/admin/upload-scan: notice scan_off when off, counts when on, head only', async () => {
    const offHead = await signIn(off, 'head');
    const offSummary = await offHead.client.get<UploadScanSummary>('/v1/admin/upload-scan');
    expect(offSummary.status).toBe(200);
    expect(offSummary.body).toEqual({
      mode: 'off',
      notice: 'scan_off',
      counts: { pending: 0, clean: 0, infected: 0, error: 0 },
    });

    await on.db.owner.pool.query(
      `INSERT INTO object_scan (object_key, source, scan_status) VALUES
       ('k/summary-1', 'message', 'clean'), ('k/summary-2', 'message', 'infected'),
       ('k/summary-3', 'message', 'infected')`,
    );
    const onSummary = await head.client.get<UploadScanSummary>('/v1/admin/upload-scan');
    expect(onSummary.status).toBe(200);
    expect(onSummary.body.mode).toBe('clamav');
    expect(onSummary.body.notice).toBeNull();
    expect(onSummary.body.counts.infected).toBeGreaterThanOrEqual(2);
    await on.db.owner.pool.query(`DELETE FROM object_scan WHERE object_key LIKE 'k/summary-%'`);

    expect((await agent.client.get('/v1/admin/upload-scan')).status).toBe(403);
    expect((await lead.client.get('/v1/admin/upload-scan')).status).toBe(403);
  });
});

describe('PORTAL_UPLOAD_DAILY_MB', () => {
  it('refuses files with 429 upload_quota once the last 24 hours hold the cap, and still takes a message without files', async () => {
    const pool = on.db.owner.pool;
    const ticket = await pool.query<{ id: string }>(
      `INSERT INTO ticket (subject, org_id) VALUES ('quota', $1) RETURNING id`,
      [orgId],
    );
    // A portal file of 1 MiB already stored today: the whole cap.
    await pool.query(
      `INSERT INTO message (ticket_id, direction, body_text, visibility, attachments)
       VALUES ($1, 'inbound', 'x', 'public', $2::jsonb)`,
      [
        ticket.rows[0]?.id,
        JSON.stringify([
          { partId: 'portal-1', filename: 'big.pdf', size: 1024 * 1024, objectKey: 'k/q' },
        ]),
      ],
    );
    const attempt = async (withFile: boolean) => {
      const client = on.client();
      const challenge = await client.get<{ challenge: string; difficultyBits: number }>(
        '/v1/portal/challenge',
      );
      const payload = {
        email: uniqueEmail('customer', 'quota.example'),
        name: 'Nok',
        category: 'api_error',
        description: 'Webhook deliveries stopped at 09:00, see the screenshot.',
        verification: {
          provider: 'pow-sha256',
          challenge: challenge.body.challenge,
          nonce: solveChallenge(challenge.body.challenge, challenge.body.difficultyBits),
        },
      };
      const data = new FormData();
      data.append('payload', JSON.stringify(payload));
      if (withFile) data.append('files', new Blob([PNG]), 'shot.png');
      return client.post<PortalSubmitted & ApiErrorBody>('/v1/portal/tickets', data);
    };
    const refused = await attempt(true);
    expect(refused.status, JSON.stringify(refused.body)).toBe(429);
    expect(refused.body.code).toBe('upload_quota');
    const plain = await attempt(false);
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
  });
});
