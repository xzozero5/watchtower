import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

import { createS3ObjectStore, type ObjectStore } from '@watchtower/channels';
import { seedIntents } from '@watchtower/db';
import {
  PORTAL_ATTACHMENT_MAX_BYTES,
  type EmailJob,
  type HumanChallenge,
  type PortalReplyResult,
  type PortalSubmitted,
  type PortalTicketView,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, uniqueEmail, type Harness, type TestClient } from '../testing/harness.js';
import { signIn, timelineOf, type ApiErrorBody, type Persona } from '../testing/ticketing.js';
import { solveChallenge } from './pow.js';

// Attachments on the public portal (R-9.1, R-9.3, T-140) against the real application, Postgres,
// Redis and the MinIO of the compose stack (the throwaway one the test run points at).

let h: Harness;
let store: ObjectStore;
let agent: Persona;
let dev: Persona;
let lead: Persona;
const DOMAIN = 'upload-acme.example';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  randomBytes(64),
]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF\n');
const pool = () => h.db.owner.pool;

/** True when the text has no lone surrogate (`encodeURIComponent` throws on one, Postgres jsonb refuses it). */
function wellFormed(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  h = await startHarness({
    env: {
      PORTAL_POW_DIFFICULTY_BITS: '8',
      PORTAL_MIN_FILL_SECONDS: '0',
      // Short, so the test of a sender that goes quiet does not wait 30 seconds.
      PORTAL_UPLOAD_IDLE_SECONDS: '2',
    },
  });
  store = createS3ObjectStore({
    endpoint: h.config.S3_ENDPOINT,
    region: h.config.S3_REGION,
    bucket: h.config.S3_BUCKET,
    accessKey: h.config.S3_ACCESS_KEY,
    secretKey: h.config.S3_SECRET_KEY,
  });
  await seedIntents(h.db.owner.db);
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent', undefined, 'Somchai Jaidee');
  dev = await signIn(h, 'dev', undefined, 'Dev One');
  const created = await lead.client.post<{ id: string }>('/v1/orgs', {
    name: 'Upload Acme',
    domains: [DOMAIN],
  });
  expect(created.status).toBe(201);
});

afterAll(async () => {
  await h.close();
});

// --- helpers ---

async function proof(client: TestClient) {
  const response = await client.get<HumanChallenge>('/v1/portal/challenge');
  expect(response.status).toBe(200);
  return {
    provider: 'pow-sha256' as const,
    challenge: response.body.challenge,
    nonce: solveChallenge(response.body.challenge, response.body.difficultyBits),
  };
}

interface Upload {
  readonly name: string;
  readonly bytes: Uint8Array;
}

function multipart(payload: unknown, files: readonly Upload[], field = 'files'): FormData {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  for (const file of files) form.append(field, new Blob([Buffer.from(file.bytes)]), file.name);
  return form;
}

async function submitForm(client: TestClient, fields: Record<string, unknown> = {}) {
  return {
    email: uniqueEmail('customer', DOMAIN),
    name: 'Nok Customer',
    category: 'api_error',
    description: 'Webhook deliveries stopped at 09:00, screenshot attached.',
    verification: await proof(client),
    ...fields,
  };
}

async function submitWith(files: readonly Upload[], fields: Record<string, unknown> = {}) {
  const client = h.client();
  const payload = await submitForm(client, fields);
  const response = await client.post<PortalSubmitted & ApiErrorBody>(
    '/v1/portal/tickets',
    multipart(payload, files),
  );
  return { client, payload, response };
}

async function jobsFor(to: string): Promise<EmailJob[]> {
  await h.relayOutbox();
  const jobs = await h.emailQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
  return jobs
    .filter((job) => (job.data as { to?: string }).to === to)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((job) => h.openEmail(job));
}

async function tokenFor(email: string): Promise<string> {
  const job = (await jobsFor(email)).at(-1);
  if (!job || !('trackingUrl' in job)) throw new Error('no portal email');
  const match = /#token=(wtp1\.[A-Za-z0-9._-]+)$/.exec(new URL(job.trackingUrl).hash);
  if (!match?.[1]) throw new Error('no token in the link');
  return match[1];
}

const asToken = (token: string) => ({ headers: { 'x-portal-token': token } });

interface StoredRecord {
  partId: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  objectKey: string;
  disposition: string;
}

async function messageRows(ticketKey: string) {
  const { rows } = await pool().query<{
    id: string;
    ticket_id: string;
    direction: string;
    attachments: StoredRecord[];
  }>(
    `SELECT m.id, m.ticket_id, m.direction, m.attachments FROM message m
     JOIN ticket t ON t.id = m.ticket_id WHERE t.number = $1 ORDER BY m.created_at, m.id`,
    [Number(ticketKey.split('-')[1])],
  );
  return rows;
}

async function ticketCount(email: string): Promise<number> {
  const { rows } = await pool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ticket t JOIN contact c ON c.id = t.requester_contact_id
     WHERE $1 = ANY (c.emails)`,
    [email],
  );
  return Number(rows[0]?.n ?? 0);
}

function download(who: Persona, ticketKey: string, messageId: string, index: number) {
  return who.client.get(
    `/v1/tickets/${ticketKey}/messages/${messageId}/attachments/${String(index)}`,
  );
}

// --- submit ---

describe('POST /v1/portal/tickets with files', () => {
  it('stores the files under random keys, records them like mail attachments, and staff download them', async () => {
    const { response, payload } = await submitWith([
      { name: 'รูปหน้าจอ error.png', bytes: PNG },
      { name: '../../etc/app.log', bytes: Buffer.from('2026-11-02 ERROR boom\n') },
    ]);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const key = response.body.ticketKey;

    const [message] = await messageRows(key);
    expect(message?.direction).toBe('inbound');
    const [first, second] = message?.attachments ?? [];
    expect(first).toMatchObject({
      partId: 'portal-1',
      filename: 'รูปหน้าจอ error.png',
      contentType: 'image/png',
      size: PNG.length,
      sha256: createHash('sha256').update(PNG).digest('hex'),
      disposition: 'attachment',
    });
    expect(second).toMatchObject({ filename: 'app.log', contentType: 'text/plain' });
    for (const record of [first, second]) {
      // Random key: nothing of the name, the ticket or the sender in it.
      expect(record?.objectKey).toMatch(
        /^attachments\/portal\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    expect(Buffer.from((await store.get(first?.objectKey ?? '')) ?? [])).toEqual(PNG);

    // Staff: the message on the timeline carries the attachment, and the download route serves it.
    const entries = (await timelineOf(agent, key)).entries;
    const entry = entries.find((e) => e.kind === 'message' && e.id === message?.id);
    expect(entry).toBeDefined();
    const file = await download(agent, key, message?.id ?? '', 0);
    expect(file.status).toBe(200);
    expect(Buffer.from(file.bytes)).toEqual(PNG);
    expect(file.headers.get('content-type')).toBe('image/png');
    const disposition = file.headers.get('content-disposition') ?? '';
    expect(disposition).toMatch(/^attachment; filename="/);
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('รูปหน้าจอ error.png')}`);
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(file.headers.get('content-security-policy')).toContain('sandbox');
    expect(file.headers.get('cache-control')).toContain('no-store');
    const log = await download(agent, key, message?.id ?? '', 1);
    expect(log.headers.get('content-type')).toBe('text/plain; charset=utf-8');

    // The upload is on the audit log (counts, never names or bytes).
    const { rows } = await pool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = 'portal.ticket.submit' AND target_id = $1`,
      [message?.ticket_id],
    );
    expect(rows[0]?.metadata).toMatchObject({ attachmentCount: 2 });
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain(payload.email);

    const downloads = await pool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'ticket.attachment_download' AND target_id = $1`,
      [message?.ticket_id],
    );
    expect(Number(downloads.rows[0]?.n)).toBe(2);
  });

  it('still takes a plain JSON submission without files', async () => {
    const client = h.client();
    const response = await client.post<PortalSubmitted>(
      '/v1/portal/tickets',
      await submitForm(client),
    );
    expect(response.status).toBe(201);
    const [message] = await messageRows(response.body.ticketKey);
    expect(message?.attachments).toEqual([]);
  });

  it('refuses a file over the size limit with 413 and keeps the proof usable', async () => {
    const big = Buffer.alloc(PORTAL_ATTACHMENT_MAX_BYTES + 1, 97);
    const client = h.client();
    const payload = await submitForm(client);
    const refused = await client.post<ApiErrorBody>(
      '/v1/portal/tickets',
      multipart(payload, [{ name: 'huge.txt', bytes: big }]),
    );
    expect(refused.status).toBe(413);
    expect(refused.body.code).toBe('attachment_rejected');
    expect(await ticketCount(payload.email)).toBe(0);
    // The same proof, with a good file this time.
    const again = await client.post<PortalSubmitted>(
      '/v1/portal/tickets',
      multipart(payload, [{ name: 'ok.png', bytes: PNG }]),
    );
    expect(again.status).toBe(201);
  });

  it('accepts a file of exactly the size limit', async () => {
    const exact = Buffer.alloc(PORTAL_ATTACHMENT_MAX_BYTES, 97);
    const { response } = await submitWith([{ name: 'exact.log', bytes: exact }]);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  it('refuses more than five files and files that are too large together', async () => {
    const many = await submitWith(
      Array.from({ length: 6 }, (_, i) => ({ name: `s${String(i)}.png`, bytes: PNG })),
    );
    expect(many.response.status).toBe(413);
    expect(many.response.body.code).toBe('attachment_rejected');
    expect(await ticketCount(many.payload.email)).toBe(0);

    const nine = Buffer.alloc(9 * 1024 * 1024, 97);
    const together = await submitWith([
      { name: 'a.txt', bytes: nine },
      { name: 'b.txt', bytes: nine },
      { name: 'c.txt', bytes: nine },
    ]);
    expect(together.response.status).toBe(413);
    expect(together.response.body.code).toBe('attachment_rejected');
  });

  it.each([
    ['a PDF named .png', 'shot.png', PDF],
    ['an executable named .txt', 'notes.txt', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00])],
    ['an SVG file', 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['an SVG named .png', 'logo.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['an HTML page named .txt', 'page.txt', Buffer.from('<!DOCTYPE html><script>1</script>')],
    ['an HTML file', 'page.html', Buffer.from('<html></html>')],
    ['a zip', 'bundle.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])],
    ['an empty file', 'empty.txt', Buffer.alloc(0)],
  ])('refuses %s with 400 and files no ticket', async (_label, name, bytes) => {
    const { response, payload } = await submitWith([{ name, bytes }]);
    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.code).toBe('attachment_rejected');
    expect(await ticketCount(payload.email)).toBe(0);
  });

  it('audits a refused upload without the file name', async () => {
    const { response } = await submitWith([{ name: 'secret-plan.svg', bytes: PNG }]);
    expect(response.status).toBe(400);
    const { rows } = await pool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = 'portal.attachment_rejected' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0]?.metadata).toMatchObject({ reason: 'extension_not_allowed', index: 0 });
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain('secret-plan');
  });

  it('refuses files in a field other than "files", and a payload that is not the form', async () => {
    const client = h.client();
    const payload = await submitForm(client);
    const wrongField = await client.post<ApiErrorBody>(
      '/v1/portal/tickets',
      multipart(payload, [{ name: 'a.png', bytes: PNG }], 'attachments'),
    );
    expect(wrongField.status).toBe(413); // multer: unexpected file field, reported as a file-count problem
    expect(wrongField.body.code).toBe('attachment_rejected');
    const notJson = new FormData();
    notJson.append('payload', '{not json');
    const bad = await client.post<ApiErrorBody>('/v1/portal/tickets', notJson);
    expect(bad.status).toBe(400);
    const extra = await client.post<ApiErrorBody>(
      '/v1/portal/tickets',
      multipart({ ...payload, attachments: ['x'] }, [{ name: 'a.png', bytes: PNG }]),
    );
    expect(extra.status).toBe(400);
  });

  it('still needs a valid proof of work when it carries files', async () => {
    const client = h.client();
    const payload = await submitForm(client);
    const response = await client.post<ApiErrorBody>(
      '/v1/portal/tickets',
      multipart({ ...payload, verification: { ...payload.verification, nonce: '1' } }, [
        { name: 'a.png', bytes: PNG },
      ]),
    );
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('verification_failed');
    expect(await ticketCount(payload.email)).toBe(0);
  });
});

// --- reply ---

describe('POST /v1/portal/tickets/:key/replies with files', () => {
  async function ticketWithToken() {
    const email = uniqueEmail('customer', DOMAIN);
    const { response } = await submitWith([], { email });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return { key: response.body.ticketKey, email, token: await tokenFor(email) };
  }

  it('adds the files to the customer message, shows names on the tracking page, and staff download them', async () => {
    const { key, token } = await ticketWithToken();
    const client = h.client();
    const sent = await client.post<PortalReplyResult & ApiErrorBody>(
      `/v1/portal/tickets/${key}/replies`,
      multipart({ body: 'Here is the log.' }, [
        { name: 'trace.log', bytes: Buffer.from('line 1\nline 2\n') },
        { name: 'screen.png', bytes: PNG },
      ]),
      asToken(token),
    );
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.message.attachments).toEqual([
      { name: 'trace.log', size: 14 },
      { name: 'screen.png', size: PNG.length },
    ]);

    const rows = await messageRows(key);
    const reply = rows.find((row) => row.id === sent.body.message.id);
    expect(reply?.attachments).toHaveLength(2);
    expect(JSON.stringify(sent.body)).not.toContain('objectKey');

    const tracking = await client.get<PortalTicketView>(
      `/v1/portal/tickets/${key}`,
      asToken(token),
    );
    const shown = tracking.body.timeline.find(
      (e) => e.kind === 'message' && e.body === 'Here is the log.',
    );
    expect(shown).toMatchObject({ attachments: [{ name: 'trace.log' }, { name: 'screen.png' }] });
    expect(JSON.stringify(tracking.body)).not.toMatch(/objectKey|attachments\/portal|sha256/);

    const file = await download(agent, key, sent.body.message.id, 1);
    expect(file.status).toBe(200);
    expect(Buffer.from(file.bytes)).toEqual(PNG);
  });

  it('answers 401 for a wrong token and stores nothing', async () => {
    const { key } = await ticketWithToken();
    const before = await messageRows(key);
    const denied = await h
      .client()
      .post<ApiErrorBody>(
        `/v1/portal/tickets/${key}/replies`,
        multipart({ body: 'hi' }, [{ name: 'a.png', bytes: PNG }]),
        asToken('wtp1.nope.nope'),
      );
    expect(denied.status).toBe(401);
    expect(denied.body.code).toBe('invalid_or_expired_link');
    const missing = await h
      .client()
      .post<ApiErrorBody>(
        `/v1/portal/tickets/${key}/replies`,
        multipart({ body: 'hi' }, [{ name: 'a.png', bytes: PNG }]),
      );
    expect(missing.status).toBe(401);
    expect(await messageRows(key)).toHaveLength(before.length);
  });

  it("refuses another ticket's token", async () => {
    const mine = await ticketWithToken();
    const other = await ticketWithToken();
    const response = await h
      .client()
      .post<ApiErrorBody>(
        `/v1/portal/tickets/${other.key}/replies`,
        multipart({ body: 'hi' }, [{ name: 'a.png', bytes: PNG }]),
        asToken(mine.token),
      );
    expect(response.status).toBe(401);
  });

  it('refuses an SVG, an oversize file and a type that is not allowed, keeping the ticket as it was', async () => {
    const { key, token } = await ticketWithToken();
    const send = (files: Upload[]) =>
      h
        .client()
        .post<ApiErrorBody>(
          `/v1/portal/tickets/${key}/replies`,
          multipart({ body: 'hi' }, files),
          asToken(token),
        );
    expect((await send([{ name: 'x.svg', bytes: Buffer.from('<svg/>') }])).status).toBe(400);
    expect((await send([{ name: 'x.png', bytes: PDF }])).status).toBe(400);
    const big = await send([
      { name: 'x.log', bytes: Buffer.alloc(PORTAL_ATTACHMENT_MAX_BYTES + 1, 97) },
    ]);
    expect(big.status).toBe(413);
    expect(big.body.code).toBe('attachment_rejected');
    expect(await messageRows(key)).toHaveLength(1);
  });

  it('removes the stored files when the reply is refused (a closed ticket)', async () => {
    const { key, token } = await ticketWithToken();
    await pool().query(`UPDATE ticket SET status = 'closed', closed_at = now() WHERE number = $1`, [
      Number(key.split('-')[1]),
    ]);
    const before = await pool().query<{ n: string }>(`SELECT count(*)::text AS n FROM message`);
    const response = await h
      .client()
      .post<ApiErrorBody>(
        `/v1/portal/tickets/${key}/replies`,
        multipart({ body: 'hi' }, [{ name: 'a.png', bytes: PNG }]),
        asToken(token),
      );
    // A closed ticket also revokes its links, so the token no longer opens it; either way nothing is saved.
    expect([401, 409]).toContain(response.status);
    const after = await pool().query<{ n: string }>(`SELECT count(*)::text AS n FROM message`);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});

// --- memory protection (security review P1-1) ---

/**
 * A multipart request that declares a large body and sends only the start of it: what a slow or
 * hostile sender looks like to the api. Resolves once the request is on the wire; `answer` resolves
 * with the status if the api answers before the body is complete.
 */
function stalledUpload(
  ip: string,
  path = '/v1/portal/tickets',
  headers: Record<string, string> = {},
) {
  const url = new URL(path, h.base);
  const request = http.request(url, {
    method: 'POST',
    headers: {
      'x-forwarded-for': ip,
      origin: new URL(h.config.APP_URL).origin,
      'content-type': 'multipart/form-data; boundary=wtboundary',
      'content-length': String(5 * 1024 * 1024),
      ...headers,
    },
  });
  const closed = new Promise<void>((resolve) => {
    request.on('close', () => {
      resolve();
    });
  });
  const answer = new Promise<number>((resolve) => {
    request.on('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
  });
  request.on('error', () => undefined);
  request.write('--wtboundary\r\nContent-Disposition: form-data; name="payload"\r\n\r\n{');
  return { request, closed, answer };
}

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A submit from `ip` that is not valid (its form is not a ticket). It gets as far as the upload slot:
 * 503 when no slot is free, 400 once its body was read and refused. So it tells busy from free.
 */
async function probe(ip: string): Promise<number> {
  const response = await fetch(`${h.base}/v1/portal/tickets`, {
    method: 'POST',
    headers: { 'x-forwarded-for': ip, origin: new URL(h.config.APP_URL).origin },
    body: multipart({ nothing: true }, [{ name: 'a.png', bytes: PNG }]),
  });
  await response.arrayBuffer();
  return response.status;
}

describe('uploads are bounded before their body is read', () => {
  it('lets one client address have one upload in flight and answers 503 with Retry-After for the next', async () => {
    const first = stalledUpload('10.20.0.1');
    await settle(300);
    const second = await fetch(`${h.base}/v1/portal/tickets`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '10.20.0.1', origin: new URL(h.config.APP_URL).origin },
      body: multipart({ nothing: true }, [{ name: 'a.png', bytes: PNG }]),
    });
    expect(second.status).toBe(503);
    expect(second.headers.get('retry-after')).toBe('5');
    expect(((await second.json()) as ApiErrorBody).code).toBe('upload_busy');
    // Another address is not held up by it.
    expect(await probe('10.20.0.2')).toBe(400);

    // When the first goes away its slot comes back.
    first.request.destroy();
    await first.closed;
    await settle(300);
    expect(await probe('10.20.0.1')).toBe(400);
  });

  it('limits uploads in flight in total, whatever the addresses', async () => {
    const held = ['10.21.0.1', '10.21.0.2', '10.21.0.3'].map((ip) => stalledUpload(ip));
    await settle(300);
    expect(await probe('10.21.0.4')).toBe(503);
    for (const upload of held) upload.request.destroy();
    await Promise.all(held.map((upload) => upload.closed));
    await settle(300);
    expect(await probe('10.21.0.4')).toBe(400);
  });

  it('cuts off a sender that goes quiet and frees its slot', async () => {
    const quiet = stalledUpload('10.22.0.1');
    await settle(300);
    expect(await probe('10.22.0.1')).toBe(503);
    // PORTAL_UPLOAD_IDLE_SECONDS is 2 in this test run.
    await Promise.race([quiet.closed, settle(8000)]);
    await settle(300);
    expect(await probe('10.22.0.1')).toBe(400);
  });

  it('checks the tracking token before it reads any of the body', async () => {
    // The body is announced but never sent. An api that read it first would wait; this answers 401.
    const noToken = stalledUpload('10.23.0.1', '/v1/portal/tickets/OPS-1/replies');
    expect(await Promise.race([noToken.answer, settle(3000).then(() => 0)])).toBe(401);
    noToken.request.destroy();
    const badToken = stalledUpload('10.23.0.2', '/v1/portal/tickets/OPS-1/replies', {
      'x-portal-token': 'wtp1.not.valid',
    });
    expect(await Promise.race([badToken.answer, settle(3000).then(() => 0)])).toBe(401);
    badToken.request.destroy();
  });

  it('reads the body of a reply only for a valid token', async () => {
    const mine = await (async () => {
      const email = uniqueEmail('customer', DOMAIN);
      const { response } = await submitWith([], { email });
      return { key: response.body.ticketKey, token: await tokenFor(email) };
    })();
    // A file in a field that is not accepted is a 413 once the body is read (see the field test),
    // and a 401 before that when the token is wrong.
    const wrongField = (token: string) =>
      h
        .client()
        .post<ApiErrorBody>(
          `/v1/portal/tickets/${mine.key}/replies`,
          multipart({ body: 'hi' }, [{ name: 'a.png', bytes: PNG }], 'attachments'),
          asToken(token),
        );
    expect((await wrongField('wtp1.nope.nope')).status).toBe(401);
    expect((await wrongField(mine.token)).status).toBe(413);
  });
});

describe('a refused file does not use up the customer reply allowance', () => {
  it('lets a good reply through after more bad files than the hourly reply limit', async () => {
    const email = uniqueEmail('customer', DOMAIN);
    const { response } = await submitWith([], { email });
    const key = response.body.ticketKey;
    const token = await tokenFor(email);
    // The client has its own address, so these only count against it.
    const client = h.client();
    for (let i = 0; i < 12; i += 1) {
      const bad = await client.post<ApiErrorBody>(
        `/v1/portal/tickets/${key}/replies`,
        multipart({ body: 'hi' }, [{ name: 'x.svg', bytes: Buffer.from('<svg/>') }]),
        asToken(token),
      );
      expect(bad.status).toBe(400);
    }
    const good = await client.post<PortalReplyResult>(
      `/v1/portal/tickets/${key}/replies`,
      multipart({ body: 'finally' }, [{ name: 'ok.png', bytes: PNG }]),
      asToken(token),
    );
    expect(good.status, JSON.stringify(good.body)).toBe(201);
  });
});

describe('file names that are long or full of emoji', () => {
  it('are cut on whole characters, so the ticket is filed and the download works', async () => {
    const name = `${'a'.repeat(118)}😀😀😀😀.png`;
    const { response } = await submitWith([{ name, bytes: PNG }]);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const [message] = await messageRows(response.body.ticketKey);
    const stored = message?.attachments[0]?.filename ?? '';
    expect(wellFormed(stored)).toBe(true);
    expect(Array.from(stored).length).toBeLessThanOrEqual(120);
    expect(stored.endsWith('.png')).toBe(true);
    const file = await download(agent, response.body.ticketKey, message?.id ?? '', 0);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toMatch(/^attachment;/);
  });
});

// --- rate limit ---

describe('upload rate limit', () => {
  it('limits requests that carry files per client address, before the body is read', async () => {
    const client = h.client();
    const statuses: number[] = [];
    for (let i = 0; i < 32; i += 1) {
      const response = await client.post<ApiErrorBody>(
        '/v1/portal/tickets/OPS-1/replies',
        multipart({ body: 'hi' }, [{ name: 'a.png', bytes: PNG }]),
        asToken('wtp1.x.y'),
      );
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.headers.get('retry-after')).not.toBeNull();
        break;
      }
    }
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.length).toBeLessThanOrEqual(31);
    const { rows } = await pool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'portal.rate_limited' AND metadata->>'scope' = 'upload-ip'`,
    );
    expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(1);
  });
});

// --- staff download ---

describe('GET /v1/tickets/:id/messages/:messageId/attachments/:index', () => {
  let key: string;
  let messageId: string;
  let ticketId: string;

  beforeAll(async () => {
    const { response } = await submitWith([{ name: 'shot.png', bytes: PNG }]);
    key = response.body.ticketKey;
    const [message] = await messageRows(key);
    messageId = message?.id ?? '';
    ticketId = message?.ticket_id ?? '';
  });

  it('needs a session', async () => {
    const response = await h.client().get(`/v1/tickets/${key}/messages/${messageId}/attachments/0`);
    expect(response.status).toBe(401);
  });

  it('is refused for a masked reader (a developer), who sees no files', async () => {
    const response = await download(dev, key, messageId, 0);
    expect(response.status).toBe(403);
  });

  it('is 404 for a client of another organization and for a client on an internal note', async () => {
    const stranger = await signIn(
      h,
      'client',
      (
        await pool().query<{ id: string }>(
          `INSERT INTO organization (name) VALUES ('Stranger Co') RETURNING id`,
        )
      ).rows[0]?.id,
    );
    expect((await download(stranger, key, messageId, 0)).status).toBe(404);

    // The ticket's own organization: a public message is theirs to download; an internal note is not.
    const { rows } = await pool().query<{ org_id: string }>(
      `SELECT org_id FROM ticket WHERE id = $1`,
      [ticketId],
    );
    const own = await signIn(h, 'client', rows[0]?.org_id);
    expect((await download(own, key, messageId, 0)).status).toBe(200);
    const note = await pool().query<{ id: string }>(
      `INSERT INTO message (ticket_id, direction, body_text, visibility, attachments, delivery_status, created_at)
       VALUES ($1, 'internal', 'internal', 'internal',
               $2::jsonb, 'not_applicable', now()) RETURNING id`,
      [
        ticketId,
        JSON.stringify([{ filename: 'n.txt', contentType: 'text/plain', objectKey: 'x/y' }]),
      ],
    );
    expect((await download(own, key, note.rows[0]?.id ?? '', 0)).status).toBe(404);
  });

  it('shows the signed-in client name, type and size of a file, but not where it is stored', async () => {
    const { rows } = await pool().query<{ org_id: string }>(
      `SELECT org_id FROM ticket WHERE id = $1`,
      [ticketId],
    );
    const own = await signIn(h, 'client', rows[0]?.org_id);
    const timeline = await own.client.get<{ entries: { attachments?: unknown[] }[] }>(
      `/v1/tickets/${key}/timeline`,
    );
    expect(timeline.status).toBe(200);
    const text = JSON.stringify(timeline.body);
    expect(text).toContain('shot.png');
    expect(text).not.toMatch(/objectKey|sha256|attachments\/portal/);
    const staff = JSON.stringify((await timelineOf(agent, key)).entries);
    expect(staff).toContain('objectKey');
  });

  it('is 404 for an unknown message, a wrong index, a message of another ticket, and a file never stored', async () => {
    expect((await download(agent, key, '00000000-0000-4000-8000-000000000000', 0)).status).toBe(
      404,
    );
    expect((await download(agent, key, messageId, 7)).status).toBe(404);
    const other = await submitWith([{ name: 'o.png', bytes: PNG }]);
    expect((await download(agent, other.response.body.ticketKey, messageId, 0)).status).toBe(404);
    const described = await pool().query<{ id: string }>(
      `INSERT INTO message (ticket_id, direction, body_text, visibility, attachments, delivery_status, created_at)
       VALUES ($1, 'inbound', 'big file', 'public', $2::jsonb, 'not_applicable', now()) RETURNING id`,
      [
        ticketId,
        JSON.stringify([{ filename: 'huge.bin', contentType: 'application/zip', objectKey: null }]),
      ],
    );
    expect((await download(agent, key, described.rows[0]?.id ?? '', 0)).status).toBe(404);
  });

  it('hands out a stored active type (mail can carry one) as an opaque download, never inline', async () => {
    const objectKey = `attachments/test/${randomBytes(6).toString('hex')}`;
    await store.put(objectKey, Buffer.from('<html><script>alert(1)</script></html>'), 'text/html');
    const inserted = await pool().query<{ id: string }>(
      `INSERT INTO message (ticket_id, direction, body_text, visibility, attachments, delivery_status, created_at)
       VALUES ($1, 'inbound', 'from mail', 'public', $2::jsonb, 'not_applicable', now()) RETURNING id`,
      [
        ticketId,
        JSON.stringify([
          { filename: 'evil"\r\n.html', contentType: 'text/html', size: 40, objectKey },
        ]),
      ],
    );
    const response = await download(agent, key, inserted.rows[0]?.id ?? '', 0);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toMatch(/^attachment;/);
    expect(disposition).not.toMatch(/[\r\n]/);
    await store.delete(objectKey);
  });
});
