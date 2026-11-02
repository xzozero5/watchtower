import type { BrowserContext, Page } from '@playwright/test';

import {
  Api,
  expect,
  fakeGmail,
  gmailSends,
  newActor,
  ORGS,
  signInStaff,
  type StaffTicket,
  test,
  type TimelineEntryJson,
  unique,
} from './support';

/**
 * AC-1, Gmail path, and PRD 5.1 (an email arrives): the real api, worker, web and database, the
 * stack's in-memory Gmail (tools/e2e-stack/worker-runner.mjs records every reply it sends: thread id
 * and headers) and the AI mock. A mail enters the way the Gmail receiver would put it (the fake
 * channel, T-122c: an `inbound_event` and an `ingest` job); Google's signed push cannot be made here.
 *
 * "Within 10 s of the push" is measured from the moment the message is queued to the moment the
 * ticket can be read, complete, through the staff API.
 */
const BUDGET_MS = 10_000;
/** PRD 5.1 step 4: pre-investigation "T+5 s to about 2 minutes". */
const BRIEF_BUDGET_MS = 120_000;

interface Actor {
  context: BrowserContext;
  page: Page;
}

interface AiBrief {
  state: string;
  intent: { key: string } | null;
  evidence: { id: string; kind: string; title: string; snippet: string }[];
  draft?: { id: string; body: string; citations: string[]; uncitedClaims: number };
  report?: { tools: { name: string; status: string }[] };
}

test.describe.serial('AC-1 (Gmail) / 5.1: an email arrives', () => {
  let head: Actor;
  let api: Api;
  const tag = unique('gm');
  const customer = `ada-${tag}@${ORGS.acme.domain}`;
  const threadId = `thr-${tag}`;
  const firstMessageId = `m1-${tag}@mail.example.test`;
  const subject = `Webhook retries are failing ${tag}`;
  const body = 'Our webhook endpoint does not receive events since this morning. Please help.';
  let ticket: StaffTicket | undefined;
  let ticketKey = '';

  async function findByTag(text: string, timeoutMs = 20_000): Promise<StaffTicket | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const list = await api.get<{ items: StaffTicket[] }>(
        `/v1/tickets?q=${encodeURIComponent(text)}`,
      );
      const found = list.json.items.find((item) => item.subject.includes(text));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
  }

  async function timeline(id: string): Promise<TimelineEntryJson[]> {
    const response = await api.get<{ entries: TimelineEntryJson[] }>(`/v1/tickets/${id}/timeline`);
    return response.json.entries;
  }

  test.beforeAll(async ({ browser }) => {
    head = await newActor(browser);
    await signInStaff(head.page);
    api = new Api(head.context.request);
    // The fake channel files mail under the Gmail account named like this; an account the head
    // registers with that name (Admin / Integrations) gets a mailbox address, which a reply needs.
    const mailbox = await api.post('/v1/admin/channel-accounts', {
      type: 'gmail',
      name: 'Fake Gmail mailbox (test)',
      emailAddress: `support-${tag}@mail.example.test`,
    });
    expect(mailbox.status).toBe(201);
  });

  test.afterAll(async () => {
    await head.context.close();
  });

  test('AC-1: a new mail from a known domain becomes a ticket with org, intent and SLA within 10 s', async () => {
    const testInfo = test.info();
    const startedAt = Date.now();
    const queued = fakeGmail({
      from: customer,
      subject,
      body,
      threadId,
      messageId: firstMessageId,
    });
    expect(queued.duplicate).toBe(false);
    ticket = await findByTag(tag, BUDGET_MS + 5_000);
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `[AC-1 Gmail] queued -> ticket readable with org/intent/SLA: ${String(elapsedMs)} ms (budget ${String(BUDGET_MS)} ms)`,
    );
    testInfo.annotations.push({
      type: 'AC-1 Gmail time to ticket (ms)',
      description: String(elapsedMs),
    });
    expect(ticket, 'the ticket exists').toBeDefined();
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
    if (!ticket) return;
    ticketKey = ticket.key;
    expect(ticket.channel).toBe('gmail');
    expect(ticket.org.name).toBe(ORGS.acme.name);
    expect(ticket.intent?.key).toBe('webhook_not_received');
    expect(ticket.slaPolicyId, 'an SLA policy was applied').not.toBeNull();
    expect(Date.parse(ticket.resolutionDueAt ?? '')).toBeGreaterThan(
      Date.parse(ticket.firstResponseDueAt ?? ''),
    );
  });

  test('5.1 C: the customer is acknowledged by email with the ticket number (any autonomy stage)', async () => {
    // B-003: PRD 5.1 step 3C says a new issue gets an auto-ack template with the ticket number. The
    // worker only builds one for LINE (apps/worker/src/ingest/auto-ack.ts); nothing goes out for Gmail.
    // Known gap: `test.fail` keeps the suite green while it exists and turns red when it is built.
    test.fail();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const acks = gmailSends().filter((send) => send.requestedThreadId === threadId);
    expect(acks.length, 'an acknowledgment was sent into the customer thread').toBeGreaterThan(0);
  });

  test('5.1 step 4: the investigation report arrives with cited KB sections and org context', async () => {
    const startedAt = Date.now();
    let brief: AiBrief | undefined;
    while (Date.now() - startedAt < BRIEF_BUDGET_MS - 60_000) {
      const response = await api.get<AiBrief>(`/v1/tickets/${ticket?.id ?? ''}/ai`);
      if (response.status === 200 && response.json.report !== undefined) {
        brief = response.json;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const reportMs = Date.now() - startedAt;
    console.log(`[5.1] ticket -> investigation report: ${String(reportMs)} ms`);
    test.info().annotations.push({ type: '5.1 report time (ms)', description: String(reportMs) });
    expect(brief, 'an investigation report').toBeDefined();
    if (!brief) return;
    expect(brief.intent?.key).toBe('webhook_not_received');

    // Evidence has KB passages (a section-level title "article > section") and the organization.
    const kb = brief.evidence.filter((card) => card.kind === 'kb');
    expect(kb.length).toBeGreaterThan(0);
    expect(
      kb.some((card) => card.title.includes(' > ')),
      'a section-level citation',
    ).toBe(true);
    expect(brief.evidence.some((card) => card.kind === 'data' && /Acme/.test(card.snippet))).toBe(
      true,
    );
    // The tools the intent runbook runs are read-only and the mock ones say so (N2).
    expect(brief.report?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['kb_search', 'org_context']),
    );
    expect(brief.report?.tools.every((tool) => tool.status === 'ok')).toBe(true);
  });

  test('5.1 step 4: a draft reply cites evidence of the brief (the AI drafts alone only for a trusted intent; otherwise the agent asks)', async () => {
    const id = ticket?.id ?? '';
    const startedAt = Date.now();
    // The mock classifier's confidence depends on the text, so the intent is trusted for some mails
    // and not for others. Stage 2 drafts on its own only when it is trusted (N3, ADR-011): otherwise
    // a person presses "Draft a reply" (Ask the AI). Both ends are the same draft.
    const page = head.page;
    await page.goto(`/?ticket=${ticketKey}`);
    const ask = page.getByRole('button', { name: 'Draft a reply' });
    const draftCard = page.getByRole('region', { name: 'Conversation' }).getByText('Draft reply');
    await expect(ask.or(draftCard).first()).toBeVisible({ timeout: 30_000 });
    if (await ask.first().isVisible()) await ask.first().click();

    let brief: AiBrief | undefined;
    while (Date.now() - startedAt < BRIEF_BUDGET_MS - 20_000) {
      const response = await api.get<AiBrief>(`/v1/tickets/${id}/ai`);
      if (response.status === 200 && response.json.draft !== undefined) {
        brief = response.json;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const draftMs = Date.now() - startedAt;
    console.log(`[5.1] draft ready ${String(draftMs)} ms after the report`);
    expect(brief?.draft, 'a draft').toBeDefined();
    const draft = brief?.draft;
    const ids = new Set(brief?.evidence.map((card) => card.id));
    expect(draft?.citations.length).toBeGreaterThan(0);
    expect(draft?.citations.every((cited) => ids.has(cited))).toBe(true);
    expect(draft?.uncitedClaims).toBe(0);
  });

  test('the agent approves the draft in the browser: the reply lands in the customer thread, in order', async () => {
    const page = head.page;
    const sendsBefore = gmailSends().length;
    await page.goto(`/?ticket=${ticketKey}`);
    const panel = page.getByRole('region', { name: 'Conversation' });
    // The draft card in the conversation: approve, confirm in the dialog (N3: a person sends).
    await expect(panel.getByText('Draft reply').first()).toBeVisible({ timeout: 30_000 });
    await panel.getByRole('button', { name: 'Approve', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Send this reply?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(customer.split('@')[0] ?? '');
    await dialog.getByRole('button', { name: 'Approve and send' }).click();
    // The reply waits a few seconds for an undo (T-109), then the worker sends it.
    await expect(panel.getByText('Waiting to send').first()).toBeVisible();

    // The Gmail API got one reply, into the thread of the customer's mail, answering their message.
    let sent = gmailSends().slice(sendsBefore);
    const deadline = Date.now() + 30_000;
    while (sent.length === 0 && Date.now() < deadline) {
      await page.waitForTimeout(250);
      sent = gmailSends().slice(sendsBefore);
    }
    expect(sent, 'exactly one reply was sent').toHaveLength(1);
    const reply = sent[0];
    expect(reply?.requestedThreadId).toBe(threadId);
    expect(reply?.gmailThreadId).toBe(threadId);
    const headers = JSON.stringify(reply?.headers);
    expect(headers).toContain(firstMessageId);
    expect(headers.toLowerCase()).toContain(subject.toLowerCase());
    expect(headers, 'a reply keeps the subject of the thread').toMatch(/Re: /i);

    const after = await api.get<StaffTicket & { firstRespondedAt: string | null }>(
      `/v1/tickets/${ticketKey}`,
    );
    expect(
      after.json.firstRespondedAt,
      'the first response is recorded for the SLA',
    ).not.toBeNull();
    const entries = await timeline(ticket?.id ?? '');
    const outbound = entries.filter((entry) => entry.kind === 'message').at(-1);
    expect(outbound?.direction).toBe('outbound');
    expect(outbound?.visibility).toBe('public');
  });

  test('the customer answers in the thread: same ticket, and a repeated Message-ID is stored once', async () => {
    const answerId = `m2-${tag}@mail.example.test`;
    const answer = 'It still fails after the change, here are the details.';
    fakeGmail({
      from: customer,
      subject: `Re: ${subject}`,
      body: answer,
      threadId,
      messageId: answerId,
      inReplyTo: firstMessageId,
    });
    // Gmail's at-least-once delivery: the same RFC Message-ID arrives again as another provider id.
    fakeGmail({
      from: customer,
      subject: `Re: ${subject}`,
      body: answer,
      threadId,
      messageId: answerId,
      inReplyTo: firstMessageId,
    });
    const id = ticket?.id ?? '';
    let mine: TimelineEntryJson[] = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      mine = (await timeline(id)).filter((entry) => entry.bodyText === answer);
      if (mine.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(mine, 'the answer is in the same ticket').toHaveLength(1);
    // Give the second delivery time to be processed, then count again.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect((await timeline(id)).filter((entry) => entry.bodyText === answer)).toHaveLength(1);
    const same = await api.get<{ items: StaffTicket[] }>(
      `/v1/tickets?q=${encodeURIComponent(tag)}`,
    );
    expect(same.json.items.filter((item) => item.subject.includes(tag))).toHaveLength(1);
  });

  test('noise: a newsletter and an automatic reply create no ticket and wait in Other mail; one click makes a ticket', async () => {
    const newsletterSubject = `Our October newsletter ${tag}`;
    const autoSubject = `Automatic reply: out of office ${tag}`;
    fakeGmail({
      from: `news-${tag}@vendor.example.net`,
      subject: newsletterSubject,
      body: 'Ten tips for your dashboards. Unsubscribe at any time.',
      kind: 'newsletter',
    });
    fakeGmail({
      from: `ooo-${tag}@vendor.example.net`,
      subject: autoSubject,
      body: 'I am out of the office until Monday.',
      kind: 'auto_reply',
    });

    const page = head.page;
    await page.goto('/other-mail');
    await expect(page.getByRole('heading', { name: 'Other mail', level: 1 })).toBeVisible();
    await expect(page.getByText(newsletterSubject).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(autoSubject).first()).toBeVisible({ timeout: 20_000 });
    // Neither is a ticket, and nothing was sent to the sender (R-2.6: no auto-ack loop).
    const found = await api.get<{ items: StaffTicket[] }>(
      `/v1/tickets?q=${encodeURIComponent(tag)}`,
    );
    expect(found.json.items.map((item) => item.subject).sort()).toEqual([subject]);
    expect(
      gmailSends().filter((send) => JSON.stringify(send.headers).includes('vendor.example.net')),
    ).toHaveLength(0);

    // "This is a ticket": converts, and tells the user which ticket.
    await page.getByText(newsletterSubject).first().click();
    await page.getByRole('button', { name: 'This is a ticket' }).click();
    await expect(page.getByText(/Ticket OPS-\d+ was opened from this message/)).toBeVisible();
    const converted = await findByTag(newsletterSubject);
    expect(converted, 'the converted message is a ticket').toBeDefined();
  });

  test('merging two tickets keeps both message histories visible', async () => {
    const secondSubject = `Same webhook problem again ${tag}`;
    const secondBody = 'We see the same webhook failure, it is a duplicate of the first report.';
    fakeGmail({
      from: `grace-${tag}@${ORGS.acme.domain}`,
      subject: secondSubject,
      body: secondBody,
      threadId: `thr2-${tag}`,
    });
    const second = await findByTag(secondSubject);
    expect(second, 'the second ticket').toBeDefined();
    if (!second || !ticket) return;

    const merged = await api.post(`/v1/tickets/${second.id}/merge`, {
      intoTicketId: ticket.id,
      reason: 'duplicate report',
    });
    expect(merged.status).toBeLessThan(300);

    const entries = await timeline(ticket.id);
    const texts = entries.map((entry) => entry.bodyText ?? '');
    expect(
      texts.some((text) => text.includes(body)),
      'the first history',
    ).toBe(true);
    expect(
      texts.some((text) => text.includes(secondBody)),
      'the merged history',
    ).toBe(true);

    const page = head.page;
    await page.goto(`/?ticket=${ticket.key}`);
    const conversation = page.getByRole('region', { name: 'Conversation' });
    await expect(conversation.getByText(secondBody).first()).toBeVisible();
    await expect(conversation.getByText(body).first()).toBeVisible();
    const after = await api.get<StaffTicket & { mergedTickets: { key: string }[] }>(
      `/v1/tickets/${ticket.key}`,
    );
    expect(after.json.mergedTickets.map((item) => item.key)).toContain(second.key);
  });
});
