import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { TicketDetail } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SafeImageFetcher } from '../egress/safe-fetch.js';
import { startHarness, type Harness } from '../testing/harness.js';
import {
  apiOrg,
  fileTicket,
  signIn,
  type ApiErrorBody,
  type Persona,
} from '../testing/ticketing.js';
import { REMOTE_IMAGE_FETCHER } from './remote-image.service.js';

// T-175: the mail reader's "Display images" goes through GET /v1/tickets/:id/messages/:mid/remote-image?u=n.
// The real application on real Postgres and Redis; the sender's web server is a local fake and the resolver
// is a fake, so nothing reaches the internet. The SSRF cases here prove the route is wired to the guard;
// the guard itself is covered address by address in egress/*.test.ts.

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40, 7),
]);
const PUBLIC = '93.184.216.34';
const NAMES: Record<string, string[]> = {
  'cdn.sender.test': [PUBLIC],
  'rebind.sender.test': ['169.254.169.254'],
  'internal.sender.test': ['10.0.0.8'],
  'redirect.sender.test': [PUBLIC],
};

let sender: http.Server;
let senderHits: string[] = [];
let h: Harness;
let agent: Persona;
let lead: Persona;
let dev: Persona;
let client: Persona;
let ticket: TicketDetail;
let messageId = '';
let orgId = '';

const IMAGES = [
  'http://cdn.sender.test/logo.png?token=SECRET-TOKEN&amp;x=1',
  'http://127.0.0.1:8080/admin.png',
  'http://169.254.169.254/latest/meta-data/',
  'http://[::1]/a.png',
  'http://10.1.2.3/a.png',
  'http://rebind.sender.test/a.png',
  'http://internal.sender.test/a.png',
  'http://redirect.sender.test/to-private',
  'http://cdn.sender.test/html-not-image',
];
const bodyHtml = `<p>Hello <b>there</b></p>${IMAGES.map((src) => `<img data-remote-src="${src}" alt="x">`).join('')}<p>data-remote-src="http://evil.test/in-text"</p>`;

beforeAll(async () => {
  sender = http.createServer((request, response) => {
    senderHits.push(request.url ?? '');
    if (request.url?.startsWith('/to-private') === true) {
      response.writeHead(302, { Location: 'http://127.0.0.1:9/inner.png' });
      response.end();
    } else if (request.url?.startsWith('/html-not-image') === true) {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end('<html><script>alert(1)</script></html>');
    } else {
      response.writeHead(200, { 'Content-Type': 'image/jpeg' });
      response.end(PNG);
    }
  });
  await new Promise<void>((resolve) => sender.listen(0, '127.0.0.1', resolve));
  const port = (sender.address() as AddressInfo).port;
  const fetcher = new SafeImageFetcher({
    allowHttp: true,
    allowedPorts: 'any',
    resolve: (name) => Promise.resolve(NAMES[name] ?? []),
    dial: () => ({ address: '127.0.0.1', port }),
  });
  h = await startHarness({ overrides: [{ token: REMOTE_IMAGE_FETCHER, value: fetcher }] });
  agent = await signIn(h, 'agent');
  lead = await signIn(h, 'lead');
  dev = await signIn(h, 'dev');
  const org = await apiOrg(lead, { name: 'Remote Image Org' });
  orgId = org.id;
  ticket = await fileTicket(lead, org.id);
  const row = await h.db.owner.pool.query<{ id: string }>(
    `UPDATE message SET body_html = $2 WHERE ticket_id = $1 RETURNING id`,
    [ticket.id, bodyHtml],
  );
  messageId = row.rows[0]?.id ?? '';
  client = await signIn(h, 'client', org.id);
});

afterAll(async () => {
  await h.close();
  sender.closeAllConnections();
  await new Promise<void>((resolve) =>
    sender.close(() => {
      resolve();
    }),
  );
});

const url = (u: number | string, who = ticket.key, mid = messageId) =>
  `/v1/tickets/${who}/messages/${mid}/remote-image?u=${String(u)}`;

async function audits(): Promise<
  { outcome: string; target_id: string; metadata: Record<string, unknown> }[]
> {
  const rows = await h.db.owner.pool.query<{
    outcome: string;
    target_id: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT outcome, target_id, metadata FROM audit_log WHERE action = 'ticket.remote_image_fetch' AND target_id = $1 ORDER BY created_at`,
    [ticket.id],
  );
  return rows.rows;
}

describe('remote-image proxy', () => {
  it('serves a picture of the stored message with nosniff, a sandbox CSP and the type from the bytes', async () => {
    senderHits = [];
    const response = await agent.client.get(url(0));
    expect(response.status).toBe(200);
    expect(Buffer.from(response.bytes).equals(PNG)).toBe(true);
    expect(response.headers.get('content-type')).toBe('image/png'); // the server said jpeg
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    // The entity in the stored attribute was undone before the request was made.
    expect(senderHits).toEqual(['/logo.png?token=SECRET-TOKEN&x=1']);
  });

  it('serves a second request from the cache without asking the sender again', async () => {
    senderHits = [];
    expect((await lead.client.get(url(0))).status).toBe(200);
    expect(senderHits).toEqual([]);
  });

  it('writes an audit row with the host but never the path, query or token', async () => {
    const rows = await audits();
    const first = rows[0];
    expect(first?.outcome).toBe('success');
    expect(first?.metadata).toMatchObject({ host: 'cdn.sender.test', index: 0, fromCache: false });
    expect(JSON.stringify(rows)).not.toContain('SECRET-TOKEN');
    expect(JSON.stringify(rows)).not.toContain('logo.png');
  });

  it.each([
    [1, '127.0.0.1 literal', 'blocked_address'],
    [2, 'cloud metadata literal', 'blocked_address'],
    [3, '::1 literal', 'blocked_address'],
    [4, '10/8 literal', 'blocked_address'],
    [5, 'name that resolves to the metadata address (rebinding)', 'blocked_address'],
    [6, 'name that resolves to 10/8', 'blocked_address'],
    [7, 'redirect to a private address', 'blocked_address'],
    [8, 'html served as image/png', 'not_image'],
  ])('answers a generic 502 for index %i (%s) and audits the reason', async (index, _name, why) => {
    senderHits = [];
    const response = await agent.client.get<ApiErrorBody>(url(index));
    expect(response.status).toBe(502);
    expect(response.body.code).toBe('remote_image_unavailable');
    // Nothing about the target leaks to the caller.
    expect(JSON.stringify(response.body)).not.toMatch(/127\.0|169\.254|10\.|private|blocked/);
    const rows = await audits();
    const last = rows[rows.length - 1];
    expect(last?.outcome).toBe('failure');
    expect(last?.metadata).toMatchObject({ index, reason: why });
    // Only the first hop of the redirect case and the html case ever reached the fake sender.
    if (index === 7) expect(senderHits).toEqual(['/to-private']);
    else if (index === 8) expect(senderHits).toEqual(['/html-not-image']);
    else expect(senderHits).toEqual([]);
  });

  it('takes the picture from the stored message only: an address in the text is not a picture, a position past the end is 404', async () => {
    expect((await agent.client.get<ApiErrorBody>(url(9))).status).toBe(404);
    expect((await agent.client.get<ApiErrorBody>(url(199))).status).toBe(404);
    expect((await agent.client.get<ApiErrorBody>(url(-1))).status).toBe(400);
    expect((await agent.client.get<ApiErrorBody>(url('http://127.0.0.1/'))).status).toBe(400);
    expect(
      (
        await agent.client.get<ApiErrorBody>(
          `/v1/tickets/${ticket.key}/messages/${messageId}/remote-image`,
        )
      ).status,
    ).toBe(400);
    expect(senderHits.filter((path) => path.includes('in-text'))).toEqual([]);
  });

  it('404 for a message of another ticket and for an unknown ticket', async () => {
    const other = await fileTicket(lead, orgId);
    expect((await agent.client.get<ApiErrorBody>(url(0, other.key))).status).toBe(404);
    expect((await agent.client.get<ApiErrorBody>(url(0, 'OPS-99999999'))).status).toBe(404);
  });

  it('is closed to a developer (masked reader), a client and a signed-out caller', async () => {
    expect((await dev.client.get<ApiErrorBody>(url(0))).status).toBe(403);
    expect((await client.client.get<ApiErrorBody>(url(0))).status).toBe(403);
    expect((await h.client().get<ApiErrorBody>(url(0))).status).toBe(401);
  });

  it('is rate limited per person', async () => {
    const limited = await signIn(h, 'agent');
    let last = 0;
    for (let i = 0; i < 305 && last !== 429; i += 1) {
      last = (await limited.client.get<ApiErrorBody>(url(0))).status;
    }
    expect(last).toBe(429);
  }, 120_000);
});
