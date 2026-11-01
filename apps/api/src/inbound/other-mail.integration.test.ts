import { randomUUID } from 'node:crypto';

import type {
  ConvertOtherMailResult,
  OtherMailDetail,
  OtherMailItem,
  TicketDetail,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import {
  apiOrg,
  fileTicket,
  signIn,
  type ApiErrorBody,
  type Page,
  type Persona,
} from '../testing/ticketing.js';

// T-119 (found missing by T-109): "Other mail" over the API: list, read and "this is a ticket".
// Rows are written the way ingestion leaves them; nothing leaves the machine.
const net = disableNetConnect();

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let client: Persona;
let gmailId: string;
let lineId: string;
let customerOrgId: string;
let startedAt: number;

const pool = () => h.db.owner.pool;

interface MailFields {
  disposition: 'noise' | 'auto_reply' | 'internal' | 'pending' | 'ticket';
  from?: string | null;
  fromName?: string | null;
  subject?: string;
  body?: string;
  receivedMinutesAgo?: number;
  account?: string;
  automated?: Record<string, unknown>;
  classification?: Record<string, unknown>;
  lineUserId?: string | null;
  ticketId?: string;
}

async function mail(fields: MailFields): Promise<string> {
  const result = await pool().query<{ id: string }>(
    `INSERT INTO inbound_message (channel_account_id, provider_message_id, from_address, from_name,
        line_user_id, subject, body_text, received_at, disposition, automated, classification, ticket_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(mins => $8), $9, $10, $11, $12)
     RETURNING id`,
    [
      fields.account ?? gmailId,
      `m-${randomUUID()}`,
      fields.from === undefined ? 'sender@unknown.example.test' : fields.from,
      fields.fromName === undefined ? 'Some Sender' : fields.fromName,
      fields.lineUserId ?? null,
      fields.subject ?? 'A subject',
      fields.body ?? 'The text of the message.',
      fields.receivedMinutesAgo ?? 1,
      fields.disposition,
      fields.automated ?? { disposition: 'human', subtype: 'none', signals: [] },
      fields.classification ?? {},
      fields.ticketId ?? null,
    ],
  );
  return result.rows[0]?.id ?? '';
}

beforeAll(async () => {
  startedAt = Date.now();
  h = await startHarness();
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  customerOrgId = (
    await apiOrg(lead, { name: 'Mail customer', domains: ['customer.example.test'] })
  ).id;
  client = await signIn(h, 'client', customerOrgId);
  gmailId = (
    await pool().query<{ id: string }>(
      `INSERT INTO channel_account (type, name) VALUES ('gmail', 'Support mailbox') RETURNING id`,
    )
  ).rows[0]?.id as string;
  lineId = (
    await pool().query<{ id: string }>(
      `INSERT INTO channel_account (type, name) VALUES ('line', 'Support LINE') RETURNING id`,
    )
  ).rows[0]?.id as string;
});

afterAll(async () => {
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
  expect(startedAt).toBeGreaterThan(0);
});

const list = (who: Persona, query = '') =>
  who.client.get<Page<OtherMailItem>>(`/v1/inbound/other-mail${query}`);

describe('who may read Other mail', () => {
  it('is staff with inbound.read; a client gets 403 and nobody signed in 401', async () => {
    for (const who of [agent, lead, head]) expect((await list(who)).status).toBe(200);
    expect((await list(client)).status).toBe(403);
    expect((await h.client().get('/v1/inbound/other-mail')).status).toBe(401);
    const id = randomUUID();
    expect((await client.client.get(`/v1/inbound/other-mail/${id}`)).status).toBe(403);
    expect((await h.client().get(`/v1/inbound/other-mail/${id}`)).status).toBe(401);
    expect((await client.client.post(`/v1/inbound/other-mail/${id}/convert`, {})).status).toBe(403);
    expect((await h.client().post(`/v1/inbound/other-mail/${id}/convert`, {})).status).toBe(401);
  });
});

describe('GET /v1/inbound/other-mail', () => {
  it('lists noise, automatic replies and internal mail, newest first, and nothing that has a ticket or waits', async () => {
    await pool().query('DELETE FROM inbound_message');
    const ticket = await fileTicket(agent, customerOrgId);
    const oldest = await mail({ disposition: 'noise', subject: 'Newsletter', receivedMinutesAgo: 30 });
    const middle = await mail({
      disposition: 'auto_reply',
      subject: 'Out of office',
      receivedMinutesAgo: 20,
      automated: { disposition: 'auto_reply', subtype: 'out_of_office', signals: ['auto-submitted'] },
    });
    const newest = await mail({
      disposition: 'internal',
      subject: 'Cron report',
      receivedMinutesAgo: 10,
      classification: {
        type: 'internal_or_machine',
        intentKey: null,
        confidence: 0.91,
        source: 'ai',
        aiRunId: null,
      },
    });
    await mail({ disposition: 'pending', subject: 'Not decided yet' });
    await mail({ disposition: 'ticket', subject: 'Became a ticket', ticketId: ticket.id });

    const response = await list(agent);
    expect(response.status).toBe(200);
    expect(response.body.items.map((item) => item.id)).toEqual([newest, middle, oldest]);
    expect(response.body.items[0]).toMatchObject({
      disposition: 'internal',
      channel: 'gmail',
      classification: { type: 'internal_or_machine', confidence: 0.91, source: 'ai' },
      automatedSubtype: null,
      attachmentCount: 0,
    });
    expect(response.body.items[1]).toMatchObject({
      disposition: 'auto_reply',
      automatedSubtype: 'out_of_office',
      classification: null,
    });
    // The list never carries a whole body or any HTML.
    for (const item of response.body.items) {
      expect(Object.keys(item)).not.toContain('bodyText');
      expect(Object.keys(item)).not.toContain('bodyHtml');
    }
  });

  it('filters by disposition, account and text, and pages with a cursor', async () => {
    await pool().query('DELETE FROM inbound_message');
    const a = await mail({ disposition: 'noise', subject: 'Invoice reminder', receivedMinutesAgo: 5 });
    const b = await mail({
      disposition: 'noise',
      subject: 'Weekly digest',
      from: 'digest@news.example.test',
      receivedMinutesAgo: 4,
    });
    const c = await mail({
      disposition: 'internal',
      subject: 'LINE system notice',
      account: lineId,
      from: null,
      lineUserId: 'Uabc',
      receivedMinutesAgo: 3,
    });

    expect((await list(agent, '?disposition=internal')).body.items.map((i) => i.id)).toEqual([c]);
    expect((await list(agent, '?disposition=noise,internal')).body.items).toHaveLength(3);
    expect((await list(agent, `?channelAccountId=${lineId}`)).body.items.map((i) => i.id)).toEqual([
      c,
    ]);
    expect((await list(agent, `?channelAccountId=${lineId}`)).body.items[0]?.channel).toBe('line');
    expect((await list(agent, '?q=digest')).body.items.map((i) => i.id)).toEqual([b]);
    expect((await list(agent, '?q=news.example')).body.items.map((i) => i.id)).toEqual([b]);
    expect((await list(agent, '?q=reminder')).body.items.map((i) => i.id)).toEqual([a]);
    // LIKE wildcards in the search are text, not patterns.
    expect((await list(agent, '?q=%25%25')).body.items).toEqual([]);

    const first = await list(agent, '?limit=2');
    expect(first.body.items.map((i) => i.id)).toEqual([c, b]);
    const second = await list(agent, `?limit=2&cursor=${first.body.nextCursor ?? ''}`);
    expect(second.body.items.map((i) => i.id)).toEqual([a]);
    expect(second.body.nextCursor).toBeNull();
    expect((await list(agent, '?cursor=nonsense')).status).toBe(400);
    expect((await list(agent, '?disposition=ticket')).status).toBe(400);
    expect((await list(agent, '?q=a')).status).toBe(400);
  });

  it('cuts the snippet at 200 characters without splitting Thai text', async () => {
    await pool().query('DELETE FROM inbound_message');
    const id = await mail({ disposition: 'noise', body: 'ก'.repeat(500) });
    const item = (await list(agent)).body.items.find((row) => row.id === id);
    expect(Array.from(item?.snippet ?? '')).toHaveLength(200);
    expect(item?.snippet.endsWith('…')).toBe(true);
  });

  it('writes a pii.read audit row for every list and read', async () => {
    await pool().query('DELETE FROM audit_log WHERE action = $1', ['pii.read']).catch(() => undefined);
    const id = await mail({ disposition: 'noise' });
    await list(lead);
    await lead.client.get(`/v1/inbound/other-mail/${id}`);
    const rows = await pool().query<{ target_type: string; target_id: string | null; actor_id: string }>(
      `SELECT target_type, target_id, actor_id FROM audit_log
        WHERE action = 'pii.read' AND target_type = 'inbound_message' AND actor_id = $1
        ORDER BY created_at`,
      [lead.userId],
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.rows.at(-1)?.target_id).toBe(id);
  });
});

describe('GET /v1/inbound/other-mail/:id', () => {
  it('returns the whole text and no HTML, and 404 for a message that is not in Other mail', async () => {
    const id = await mail({ disposition: 'noise', body: 'Line one\nLine two' });
    await pool().query(`UPDATE inbound_message SET body_html = '<b>hidden</b>' WHERE id = $1`, [id]);
    const response = await agent.client.get<OtherMailDetail>(`/v1/inbound/other-mail/${id}`);
    expect(response.status).toBe(200);
    expect(response.body.bodyText).toBe('Line one\nLine two');
    expect(JSON.stringify(response.body)).not.toContain('hidden');

    const ticket = await fileTicket(agent, customerOrgId);
    const decided = await mail({ disposition: 'ticket', ticketId: ticket.id });
    expect((await agent.client.get(`/v1/inbound/other-mail/${decided}`)).status).toBe(404);
    expect((await agent.client.get(`/v1/inbound/other-mail/${randomUUID()}`)).status).toBe(404);
    expect((await agent.client.get('/v1/inbound/other-mail/not-a-uuid')).status).toBe(400);
  });
});

describe('POST /v1/inbound/other-mail/:id/convert', () => {
  const convert = (who: Persona, id: string, body: Record<string, unknown> = {}) =>
    who.client.post<ConvertOtherMailResult & Partial<ApiErrorBody>>(
      `/v1/inbound/other-mail/${id}/convert`,
      body,
    );

  it('opens a ticket from a noise message for a sender of an organization, as the person, and sends nothing', async () => {
    const id = await mail({
      disposition: 'noise',
      from: 'somchai@customer.example.test',
      fromName: 'Somchai',
      subject: 'Cannot export report',
      body: 'Please look at this export problem.',
    });
    const outboundBefore = await pool().query<{ n: string }>(
      `SELECT (SELECT count(*) FROM outbound_delivery) + (SELECT count(*) FROM outbox WHERE queue = 'outbound') AS n`,
    );

    const response = await convert(agent, id, { priority: 'P2' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ inboundMessageId: id, convertedFrom: 'noise' });
    expect(response.body.ticketKey).toMatch(/^[A-Z]+-\d+$/);

    const ticket = await agent.client.get<TicketDetail>(`/v1/tickets/${response.body.ticketId}`);
    expect(ticket.body).toMatchObject({
      subject: 'Cannot export report',
      channel: 'gmail',
      priority: 'P2',
      org: { id: customerOrgId },
      requester: { name: 'Somchai' },
    });

    const row = await pool().query<{
      disposition: string;
      converted_from: string;
      disposition_by: string;
      ticket_id: string;
      message_id: string;
    }>(
      `SELECT disposition, converted_from, disposition_by, ticket_id, message_id FROM inbound_message WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]).toMatchObject({
      disposition: 'ticket',
      converted_from: 'noise',
      disposition_by: `user:${agent.userId}`,
      ticket_id: response.body.ticketId,
    });
    expect(row.rows[0]?.message_id).toBeTruthy();

    const audit = await pool().query<{ actor_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_id, metadata FROM audit_log WHERE action = 'inbound.convert' AND target_id = $1`,
      [id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.actor_id).toBe(agent.userId);
    expect(audit.rows[0]?.metadata).toMatchObject({
      convertedFrom: 'noise',
      ticketId: response.body.ticketId,
    });
    // Ids and labels only: not the sender's address or the text.
    expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain('somchai');

    // Nothing reached the customer: no delivery, no acknowledgment, no outbound trigger.
    const outboundAfter = await pool().query<{ n: string }>(
      `SELECT (SELECT count(*) FROM outbound_delivery) + (SELECT count(*) FROM outbox WHERE queue = 'outbound') AS n`,
    );
    expect(outboundAfter.rows[0]?.n).toBe(outboundBefore.rows[0]?.n);

    // It left Other mail.
    expect((await list(agent)).body.items.map((item) => item.id)).not.toContain(id);
    expect((await agent.client.get(`/v1/inbound/other-mail/${id}`)).status).toBe(404);
  });

  it('is idempotent: asking again returns the same ticket and writes nothing new', async () => {
    const id = await mail({ disposition: 'auto_reply', from: 'robot@customer.example.test' });
    const first = await convert(lead, id);
    expect(first.status).toBe(200);
    expect(first.body.convertedFrom).toBe('auto_reply');
    const tickets = await pool().query<{ n: string }>(`SELECT count(*) AS n FROM ticket`);
    const again = await convert(head, id);
    expect(again.status).toBe(200);
    expect(again.body.ticketId).toBe(first.body.ticketId);
    expect((await pool().query<{ n: string }>(`SELECT count(*) AS n FROM ticket`)).rows[0]?.n).toBe(
      tickets.rows[0]?.n,
    );
    // The conversion itself is on the log once. (The repeated request is a mutation request and
    // leaves its own request-level row; it does not carry a second ticket.)
    const audit = await pool().query(
      `SELECT 1 FROM audit_log WHERE action = 'inbound.convert' AND target_id = $1
         AND metadata ? 'convertedFrom'`,
      [id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('puts an unknown sender in the placeholder organization as an unverified contact', async () => {
    const id = await mail({
      disposition: 'internal',
      from: 'stranger@nobody.example.test',
      fromName: 'A Stranger',
    });
    const response = await convert(agent, id);
    expect(response.status).toBe(200);
    const ticket = await agent.client.get<TicketDetail>(`/v1/tickets/${response.body.ticketId}`);
    expect(ticket.body.org.name).toBe('Unidentified senders');
    const contact = await pool().query<{ verified_at: Date | null }>(
      `SELECT verified_at FROM contact WHERE id = $1`,
      [ticket.body.requester?.id],
    );
    expect(contact.rows[0]?.verified_at).toBeNull();
  });

  it('works for a LINE message too', async () => {
    const id = await mail({
      disposition: 'noise',
      account: lineId,
      from: null,
      fromName: null,
      lineUserId: `U${randomUUID().replaceAll('-', '')}`,
      subject: '',
      body: 'ช่วยดูให้หน่อยครับ ระบบใช้งานไม่ได้',
    });
    const response = await convert(agent, id);
    expect(response.status).toBe(200);
    const ticket = await agent.client.get<TicketDetail>(`/v1/tickets/${response.body.ticketId}`);
    expect(ticket.body.channel).toBe('line');
    expect(ticket.body.subject).toBe('ช่วยดูให้หน่อยครับ ระบบใช้งานไม่ได้');
  });

  it('refuses a message that is a ticket already or not decided (409), an unknown one (404) and a bad body (400)', async () => {
    const ticket = await fileTicket(agent, customerOrgId);
    const decided = await mail({ disposition: 'ticket', ticketId: ticket.id });
    const refused = await convert(agent, decided);
    expect(refused.status).toBe(409);
    const pending = await mail({ disposition: 'pending' });
    expect((await convert(agent, pending)).status).toBe(409);
    expect((await convert(agent, randomUUID())).status).toBe(404);
    const noise = await mail({ disposition: 'noise' });
    expect((await convert(agent, noise, { priority: 'P9' })).status).toBe(400);
    // The refusals changed nothing.
    const state = await pool().query<{ disposition: string }>(
      `SELECT disposition FROM inbound_message WHERE id = $1`,
      [noise],
    );
    expect(state.rows[0]?.disposition).toBe('noise');
  });

  it('refuses a sender whose organization is inactive (409) and leaves the message in Other mail', async () => {
    const inactive = await apiOrg(lead, { name: 'Gone customer', domains: ['gone.example.test'] });
    const contact = await lead.client.post('/v1/contacts', {
      orgId: inactive.id,
      name: 'Someone',
      emails: ['someone@gone.example.test'],
    });
    expect(contact.status).toBe(201);
    await lead.client.patch(`/v1/orgs/${inactive.id}`, { status: 'inactive' });
    const id = await mail({ disposition: 'noise', from: 'someone@gone.example.test' });
    const response = await convert(agent, id);
    expect(response.status).toBe(409);
    const state = await pool().query<{ disposition: string }>(
      `SELECT disposition FROM inbound_message WHERE id = $1`,
      [id],
    );
    expect(state.rows[0]?.disposition).toBe('noise');
    const failure = await pool().query<{ outcome: string }>(
      `SELECT outcome FROM audit_log WHERE action = 'inbound.convert' AND target_id = $1`,
      [id],
    );
    expect(failure.rows.map((row) => row.outcome)).toEqual(['failure']);
  });
});
