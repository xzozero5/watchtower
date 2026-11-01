import { OPEN_STATUSES, type TicketStatus } from '@watchtower/shared';
import type { BrowserContext, Page } from '@playwright/test';

import {
  Api,
  expect,
  Mailbox,
  newActor,
  ORGS,
  signInClient,
  signInStaff,
  type StaffTicket,
  test,
  type TimelineEntryJson,
  unique,
} from './support';

/**
 * RBAC end to end (PRD 2.3): a client user sees only the tickets of their own organization, through
 * REST and through the UI, and never an internal note. Two clients of two organizations are signed
 * in through the real magic link; the staff view of the same data is the reference.
 */
interface Client {
  context: BrowserContext;
  page: Page;
  api: Api;
  mailbox: Mailbox;
  orgId: string;
}

const STAFF_ONLY_FIELDS = [
  'org',
  'assignee',
  'queue',
  'channel',
  'slaPolicyId',
  'firstResponseDueAt',
  'resolutionDueAt',
  'tags',
  'customFields',
  'autonomyStageAtCreation',
  'aiHandled',
  'csatScore',
];

test.describe.serial('RBAC: a client sees only their own organization', () => {
  let staff: Actor;
  let acme: Client;
  let borealis: Client;
  let all: StaffTicket[] = [];
  let acmeTickets: StaffTicket[] = [];
  let borealisTickets: StaffTicket[] = [];
  let noted: StaffTicket;
  const marker = unique('zqinternal');
  const noteText = `${marker} the customer is on a legacy contract`;

  interface Actor {
    context: BrowserContext;
    page: Page;
    api: Api;
  }

  async function client(browser: Parameters<typeof newActor>[0], domain: string): Promise<Client> {
    const mailbox = new Mailbox(`${unique('e2e-client')}@${domain}`);
    const actor = await newActor(browser);
    await signInClient(actor.page, mailbox);
    const api = new Api(actor.context.request);
    const session = await api.get<{ user: { orgId: string } }>('/v1/auth/session');
    return { ...actor, api, mailbox, orgId: session.json.user.orgId };
  }

  test.beforeAll(async ({ browser }) => {
    const staffActor = await newActor(browser);
    await signInStaff(staffActor.page);
    staff = { ...staffActor, api: new Api(staffActor.context.request) };

    acme = await client(browser, ORGS.acme.domain);
    borealis = await client(browser, ORGS.borealis.domain);

    all = await staff.api.all<StaffTicket>('/v1/tickets');
    acmeTickets = all.filter((ticket) => ticket.org.id === acme.orgId);
    borealisTickets = all.filter((ticket) => ticket.org.id === borealis.orgId);

    // An internal note on an Acme ticket that is still open for messages.
    const open = acmeTickets.find((ticket) => !['closed', 'merged'].includes(ticket.status));
    if (!open) throw new Error('the seed has no open Acme ticket');
    noted = open;
    const note = await staff.api.post(`/v1/tickets/${noted.id}/notes`, { body: noteText });
    expect(note.status).toBe(201);
  });

  test.afterAll(async () => {
    for (const actor of [staff, acme, borealis]) await actor.context.close();
    await acme.mailbox.delete();
    await borealis.mailbox.delete();
  });

  test('the staff view has tickets of several organizations (the test is meaningful)', () => {
    expect(acme.orgId).not.toBe(borealis.orgId);
    expect(acmeTickets.length).toBeGreaterThan(3);
    expect(borealisTickets.length).toBeGreaterThan(3);
    expect(new Set(all.map((ticket) => ticket.org.id)).size).toBeGreaterThanOrEqual(3);
  });

  for (const side of ['acme', 'borealis'] as const) {
    test(`REST: the ${side} client lists exactly the tickets of ${side}`, async () => {
      const me = side === 'acme' ? acme : borealis;
      const mine = side === 'acme' ? acmeTickets : borealisTickets;
      const theirs = side === 'acme' ? borealisTickets : acmeTickets;

      const listed = await me.api.all<Record<string, unknown> & { id: string; key: string }>(
        '/v1/tickets',
      );
      expect(new Set(listed.map((ticket) => ticket.id))).toEqual(
        new Set(mine.map((ticket) => ticket.id)),
      );
      for (const ticket of theirs) {
        expect(listed.some((item) => item.id === ticket.id || item.key === ticket.key)).toBe(false);
      }
      // A client's ticket has none of the internal fields.
      for (const item of listed) {
        for (const field of STAFF_ONLY_FIELDS) expect(item).not.toHaveProperty(field);
      }

      // Another organization's ticket does not exist for them: by key, by id, and everything under it.
      const foreign = theirs[0];
      if (!foreign) throw new Error('no foreign ticket');
      for (const ref of [foreign.key, foreign.id]) {
        expect((await me.api.get(`/v1/tickets/${ref}`)).status, `GET ticket ${ref}`).toBe(404);
        expect((await me.api.get(`/v1/tickets/${ref}/timeline`)).status).toBe(404);
      }
      const reply = await me.api.post(`/v1/tickets/${foreign.id}/replies`, { body: 'hello' });
      expect([403, 404]).toContain(reply.status);
      // ... and the foreign thread did not change.
      const thread = await staff.api.get<{ entries: TimelineEntryJson[] }>(
        `/v1/tickets/${foreign.id}/timeline`,
      );
      expect(thread.json.entries.some((e) => e.bodyText === 'hello')).toBe(false);

      // Filters cannot widen the scope.
      const widened = await me.api.all<{ id: string }>(`/v1/tickets?orgId=${foreign.org.id}`);
      expect(widened.every((item) => mine.some((ticket) => ticket.id === item.id))).toBe(true);

      // The organization directory lists their own organization only.
      const orgs = await me.api.all<{ id: string }>('/v1/orgs');
      expect(orgs.map((org) => org.id)).toEqual([me.orgId]);
      expect((await me.api.get(`/v1/orgs/${foreign.org.id}`)).status).toBe(404);
    });
  }

  test('REST: the client never gets an internal note, by timeline or by search', async () => {
    const timeline = await acme.api.get<{ entries: TimelineEntryJson[] }>(
      `/v1/tickets/${noted.id}/timeline`,
    );
    expect(timeline.status).toBe(200);
    expect(timeline.json.entries.length).toBeGreaterThan(0);
    expect(timeline.json.entries.every((entry) => entry.visibility === 'public')).toBe(true);
    expect(JSON.stringify(timeline.json)).not.toContain(marker);

    // Staff find the note by its words, so the empty result for the client is a real filter.
    const staffSearch = await staff.api.all<{ id: string }>(`/v1/tickets?q=${marker}`);
    expect(staffSearch.map((ticket) => ticket.id)).toContain(noted.id);
    const clientSearch = await acme.api.all<{ id: string }>(`/v1/tickets?q=${marker}`);
    expect(clientSearch).toEqual([]);

    // The ticket itself, as a client sees it, carries no note either.
    const own = await acme.api.get(`/v1/tickets/${noted.key}`);
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.json)).not.toContain(marker);
  });

  test('REST: staff-only actions and data are refused to a client', async () => {
    const mine = noted;
    expect((await acme.api.post(`/v1/tickets/${mine.id}/notes`, { body: 'sneaky' })).status).toBe(
      403,
    );
    expect(
      (await acme.api.post(`/v1/tickets/${mine.id}/status`, { status: 'closed' })).status,
    ).toBe(403);
    for (const path of [
      '/v1/users',
      '/v1/audit-logs',
      '/v1/contacts',
      '/v1/queues',
      '/v1/rbac/roles',
    ]) {
      const response = await acme.api.get(path);
      expect([403, 404], `GET ${path}`).toContain(response.status);
    }
    // The ticket kept its status and gained no note.
    const staffView = await staff.api.get<StaffTicket>(`/v1/tickets/${mine.id}`);
    expect(staffView.json.status).toBe(mine.status);
    const thread = await staff.api.get<{ entries: TimelineEntryJson[] }>(
      `/v1/tickets/${mine.id}/timeline`,
    );
    expect(thread.json.entries.some((e) => e.bodyText === 'sneaky')).toBe(false);
  });

  for (const side of ['acme', 'borealis'] as const) {
    test(`UI: the ${side} client's queue holds only their organization's tickets`, async () => {
      const me = side === 'acme' ? acme : borealis;
      const mine = side === 'acme' ? acmeTickets : borealisTickets;
      const theirs = side === 'acme' ? borealisTickets : acmeTickets;
      const myOrg = side === 'acme' ? ORGS.acme.name : ORGS.borealis.name;
      const otherOrg = side === 'acme' ? ORGS.borealis.name : ORGS.acme.name;

      await me.page.goto('/');
      const queue = me.page.getByRole('listbox', { name: 'Tickets' });
      await expect(queue.getByRole('option').first()).toBeVisible();
      // The queue opens on the "open" view: every ticket of the organization that is not yet resolved.
      const expected = mine.filter((ticket) =>
        OPEN_STATUSES.includes(ticket.status as TicketStatus),
      );
      await expect(queue.getByRole('option')).toHaveCount(expected.length);

      const shown = await queue
        .getByRole('option')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-ticket-key')));
      const mineKeys = new Set(mine.map((ticket) => ticket.key));
      expect(shown.length).toBeGreaterThan(0);
      for (const key of shown) expect(mineKeys.has(key ?? '')).toBe(true);
      for (const ticket of theirs) expect(shown).not.toContain(ticket.key);

      // Subjects of the other organization are nowhere on the page, and no org column is shown.
      const sample = theirs.slice(0, 5);
      for (const ticket of sample) await expect(me.page.getByText(ticket.subject)).toHaveCount(0);
      await expect(me.page.getByText(otherOrg)).toHaveCount(0);
      await expect(queue).not.toContainText(myOrg);
    });
  }

  test('UI: the client reads their ticket without the internal note and cannot write one', async () => {
    const page = acme.page;
    await page.goto(`/?ticket=${noted.key}`);
    const conversation = page.getByRole('region', { name: 'Conversation' });
    await expect(
      conversation.getByRole('heading', { name: noted.subject, level: 3 }),
    ).toBeVisible();
    // Wait for the messages to load, then check that the note is not among them.
    await expect(conversation.getByRole('textbox')).toBeVisible();
    await expect(conversation.getByText(marker)).toHaveCount(0);
    await expect(page.getByText(marker)).toHaveCount(0);
    // A client's composer has no internal-note mode.
    await expect(page.getByRole('radio', { name: 'Internal note' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Internal note' })).toHaveCount(0);
    await expect(conversation.getByText('Your message is added to this ticket')).toBeVisible();
    // Staff controls are read-only: no assignee, no editable status.
    // A client has no side panel: their read-only facts sit in the conversation.
    await expect(page.getByRole('region', { name: 'Details & AI' })).toHaveCount(0);
    const details = conversation.getByRole('region', { name: 'Ticket details' });
    await expect(details).toBeVisible();
    await expect(details.getByRole('button')).toHaveCount(0);
    await expect(details).not.toContainText('Assignee');
    await expect(details).not.toContainText(ORGS.acme.name);
    // The status is shown in the customer's words.
    await expect(page.locator('[data-customer-status]').first()).toBeVisible();
  });

  test("UI: another organization's ticket opened by address is not found", async () => {
    const foreign = borealisTickets[0];
    if (!foreign) throw new Error('no foreign ticket');
    await acme.page.goto(`/?ticket=${foreign.key}`);
    const conversation = acme.page.getByRole('region', { name: 'Conversation' });
    await expect(conversation.getByText('Ticket not found')).toBeVisible();
    await expect(acme.page.getByText(foreign.subject)).toHaveCount(0);

    // And the other way round: Borealis cannot open the Acme ticket that carries the note.
    await borealis.page.goto(`/?ticket=${noted.key}`);
    const theirs = borealis.page.getByRole('region', { name: 'Conversation' });
    await expect(theirs.getByText('Ticket not found')).toBeVisible();
    await expect(borealis.page.getByText(noted.subject)).toHaveCount(0);
  });

  test('UI: staff see the same ticket with the internal note', async () => {
    await staff.page.goto(`/?ticket=${noted.key}`);
    const conversation = staff.page.getByRole('region', { name: 'Conversation' });
    await expect(conversation.getByText(noteText)).toBeVisible();
    // Staff can add internal notes: a dock button with an AI brief (T-128), a radio without one.
    await expect(
      staff.page
        .getByRole('button', { name: /^Internal note\b/ })
        .or(staff.page.getByRole('radio', { name: 'Internal note' }))
        .first(),
    ).toBeVisible();
  });
});
