import { createHash } from 'node:crypto';

import type { BrowserContext, Page } from '@playwright/test';

import {
  Api,
  expect,
  lineCalls,
  lineSignature,
  Mailbox,
  newActor,
  openComposer,
  ORGS,
  signInClient,
  signInDev,
  signInStaff,
  stack,
  type StaffTicket,
  test,
  type TimelineEntryJson,
  unique,
} from './support';

/**
 * AC-2 and PRD 5.2 (a LINE message arrives), with the real api, worker, web and database and the
 * stack's in-memory LINE Messaging API (tools/e2e-stack/line-transport.mjs). The webhook is the real
 * one: signed with the channel secret of the stack, answered 200 at once, processed by the worker.
 *
 * "Within 5 s" is measured from just before the webhook request to the moment the worker handed the
 * reply to LINE (the transport records its own clock; same machine, same clock).
 */
const ACK_BUDGET_MS = 5_000;
/** The id the fake LINE Login of the stack signs in as (apps/api/src/line/line-login.ts). */
const MOCK_LOGIN_LINE_USER = 'Umock00000000000000000000000000001';

interface Actor {
  context: BrowserContext;
  page: Page;
}

function lineEvent(userId: string, text: string, webhookEventId?: string) {
  return {
    type: 'message',
    mode: 'active',
    timestamp: Date.now(),
    webhookEventId: webhookEventId ?? `01${unique('ev').replace('-', '').toUpperCase()}`,
    deliveryContext: { isRedelivery: false },
    source: { type: 'user', userId },
    replyToken: createHash('sha256').update(unique('token')).digest('hex').slice(0, 32),
    message: { type: 'text', id: unique('m').replace('-', ''), text },
  };
}

test.describe.serial('AC-2 / 5.2: LINE message from an unlinked user', () => {
  let head: Actor;
  let headApi: Api;
  let agent: Actor;
  let agentApi: Api;
  let webhookUrl = '';
  let ticket: StaffTicket | undefined;
  let ackMs = 0;
  /** When the last webhook of the customer was accepted: its reply token ages from here. */
  let lastWebhookAt = 0;
  const marker = unique('line');
  const firstText = `Our webhook stopped delivering events ${marker}`;
  const agentReply = `We are looking into it now (${unique('reply')}).`;

  async function post(raw: string, signature: string | null = lineSignature(raw)) {
    return fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signature === null ? {} : { 'x-line-signature': signature }),
      },
      body: raw,
    });
  }

  async function findTicket(text: string, timeoutMs = 15_000): Promise<StaffTicket | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const list = await headApi.get<{ items: StaffTicket[] }>(
        `/v1/tickets?channel=line&q=${encodeURIComponent(text.slice(-14))}`,
      );
      const found = list.json.items.find((item) => item.subject.includes(text.slice(-14)));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
  }

  test.beforeAll(async ({ browser }) => {
    head = await newActor(browser);
    await signInStaff(head.page);
    headApi = new Api(head.context.request);
    agent = await newActor(browser);
    await signInDev(agent.page, 'agent');
    agentApi = new Api(agent.context.request);

    // The instance has one LINE account (head, Admin / Integrations); the channel secret is the stack's.
    const created = await headApi.post<{ id: string; webhookUrl: string }>(
      '/v1/admin/channel-accounts',
      { type: 'line', name: `E2E LINE OA ${marker}` },
    );
    expect(created.status).toBe(201);
    webhookUrl = new URL(`/v1/inbound/line/${created.json.id}`, stack().apiUrl).toString();
  });

  test.afterAll(async () => {
    await head.context.close();
    await agent.context.close();
  });

  test('a signature that does not match is refused and creates nothing', async () => {
    const raw = JSON.stringify({
      destination: 'Ubot',
      events: [lineEvent('Ubadsig00000000000000000000000001', `forged ${marker}`)],
    });
    const bad = await post(raw, lineSignature(`${raw} `));
    expect(bad.status).toBe(401);
    const missing = await post(raw, null);
    expect(missing.status).toBe(401);
    expect(await findTicket(`forged ${marker}`, 2_000)).toBeUndefined();
  });

  test('AC-2: the first message creates a ticket and is acknowledged with the reply token within 5 s', async () => {
    const testInfo = test.info();
    const callsBefore = lineCalls().length;
    const raw = JSON.stringify({
      destination: 'Ubot',
      events: [lineEvent(MOCK_LOGIN_LINE_USER, firstText)],
    });

    const startedAt = Date.now();
    const response = await post(raw);
    const answeredMs = Date.now() - startedAt;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1, duplicates: 0, rejected: 0 });
    // R-2.9: the receiver answers at once; it does not wait for the worker.
    expect(answeredMs).toBeLessThan(2_000);

    // The worker hands the acknowledgment to LINE as a reply (the free, single-use token).
    let reply = lineCalls()
      .slice(callsBefore)
      .find((call) => call.call === 'reply');
    while (!reply && Date.now() - startedAt < ACK_BUDGET_MS + 10_000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      reply = lineCalls()
        .slice(callsBefore)
        .find((call) => call.call === 'reply');
    }
    expect(reply, 'the acknowledgment reached LINE').toBeDefined();
    ackMs = (reply?.at ?? Number.MAX_SAFE_INTEGER) - startedAt;
    console.log(
      `[AC-2] webhook request -> ack handed to LINE: ${String(ackMs)} ms (budget ${String(ACK_BUDGET_MS)} ms); webhook answered in ${String(answeredMs)} ms`,
    );
    testInfo.annotations.push({ type: 'AC-2 ack time (ms)', description: String(ackMs) });
    expect(reply?.ok).toBe(true);
    expect(ackMs).toBeLessThan(ACK_BUDGET_MS);
    expect(reply?.texts?.join(' ')).toMatch(/OPS-\d+/);

    ticket = await findTicket(firstText);
    expect(ticket, 'the ticket exists').toBeDefined();
    expect(ticket?.channel).toBe('line');
    // The ack text names the ticket it belongs to.
    expect(reply?.texts?.join(' ')).toContain(ticket?.key ?? 'missing');
  });

  test('a customer who keeps writing is not acknowledged again, and a redelivery makes no second ticket', async () => {
    const callsBefore = lineCalls().length;
    const more = lineEvent(MOCK_LOGIN_LINE_USER, `And it is urgent ${marker}`);
    lastWebhookAt = Date.now();
    expect((await post(JSON.stringify({ destination: 'Ubot', events: [more] }))).status).toBe(200);
    // The same event again (LINE redelivers): ignored.
    const again = await post(JSON.stringify({ destination: 'Ubot', events: [more] }));
    expect(await again.json()).toEqual({ accepted: 0, duplicates: 1, rejected: 0 });

    // Wait until the follow-up is in the ticket, then check nothing else went out.
    const id = ticket?.id ?? '';
    let entries: TimelineEntryJson[] = [];
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const timeline = await headApi.get<{ entries: TimelineEntryJson[] }>(
        `/v1/tickets/${id}/timeline`,
      );
      entries = timeline.json.entries;
      if (entries.some((entry) => entry.bodyText?.includes('And it is urgent'))) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(entries.some((entry) => entry.bodyText?.includes('And it is urgent'))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(
      lineCalls()
        .slice(callsBefore)
        .filter((call) => call.call === 'reply'),
    ).toEqual([]);
    const all = await headApi.get<{ items: StaffTicket[] }>(
      `/v1/tickets?channel=line&q=${encodeURIComponent(marker)}`,
    );
    expect(all.json.items.filter((item) => item.subject.includes(marker))).toHaveLength(1);
  });

  test('the ticket is filed under the unidentified placeholder and the contact is unverified', async () => {
    const page = head.page;
    await page.goto(`/?ticket=${ticket?.key ?? ''}`);
    const conversation = page.getByRole('region', { name: 'Conversation' });
    await expect(conversation.getByText(firstText).first()).toBeVisible();
    const details = page.getByRole('region', { name: 'Details & AI' });
    await details.getByRole('tab', { name: 'Details' }).click();
    await expect(details).toContainText('Unidentified senders');
    await expect(details).toContainText('LINE user');

    // The contact record says it outright: the admin organization page lists it as unverified.
    expect(ticket?.org.name).toBe('Unidentified senders');
    await page.goto(`/admin/orgs/${ticket?.org.id ?? ''}`);
    await page.getByRole('tab', { name: 'Contacts' }).click();
    const contactRow = page.getByRole('row', { name: /LINE user/ }).first();
    await expect(contactRow).toContainText('Unverified');
    await expect(contactRow).toContainText('LINE not verified');
  });

  test('linking by LINE Login merges the identity: the ticket follows the client to their organization', async ({
    browser,
  }) => {
    const mailbox = new Mailbox(`${unique('e2e-somchai')}@${ORGS.acme.domain}`);
    const client = await newActor(browser);
    try {
      await signInClient(client.page, mailbox);
      const clientApi = new Api(client.context.request);
      const start = await clientApi.post<{ authorizeUrl: string }>('/v1/line/login/start');
      expect(start.status).toBe(200);
      // The fake provider approves at once; the browser follows the redirect back to the portal.
      await client.page.goto(start.json.authorizeUrl);
      await client.page.waitForURL(/line_login=linked/);
    } finally {
      await mailbox.delete();
      await client.context.close();
    }
    const after = await headApi.get<StaffTicket>(`/v1/tickets/${ticket?.id ?? ''}`);
    expect(after.json.org.name, 'the ticket moved from the placeholder to the client org').toBe(
      ORGS.acme.name,
    );
  });

  /** Types a public reply in the workspace as the signed-in agent and presses send. */
  async function agentSends(text: string): Promise<void> {
    const page = agent.page;
    await page.goto(`/?ticket=${ticket?.key ?? ''}`);
    await openComposer(page, 'reply');
    await page.getByRole('textbox', { name: 'Public reply' }).fill(text);
    await page.getByRole('button', { name: 'Send reply', exact: true }).click();
  }

  /** The call to LINE that carried this text; a reply waits a few seconds for an undo (T-109). */
  async function lineCallWith(text: string, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = lineCalls().find((call) => call.texts?.includes(text));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`nothing carrying that text reached LINE in ${String(timeoutMs)} ms`);
  }

  const usedQuota = async (): Promise<number> =>
    (await agentApi.get<{ accounts: { used: number }[] }>('/v1/line/quota')).json.accounts[0]
      ?.used ?? -1;

  test('a reply within a minute of the customer writing uses the free reply token (cost-aware routing)', async () => {
    const quotaBefore = await usedQuota();
    expect(quotaBefore).toBeGreaterThanOrEqual(0);
    const text = `Quick answer ${unique('fast')}`;
    await agentSends(text);
    const call = await lineCallWith(text);
    expect(call.call, 'a fresh reply token is free, so it is used').toBe('reply');
    expect(call.ok).toBe(true);
    expect(await usedQuota(), 'a reply token does not count against the quota').toBe(quotaBefore);
  });

  test('a later reply goes out as a push and the quota counts it, in the api and on the screen', async () => {
    // Reply tokens last about a minute (the router stops using one 3 s before 50 s): wait it out.
    const waitMs = lastWebhookAt + 52_000 - Date.now();
    if (waitMs > 0) await agent.page.waitForTimeout(waitMs);
    const quotaBefore = await usedQuota();
    const page = agent.page;
    await agentSends(agentReply);
    const call = await lineCallWith(agentReply);
    expect(call.call, 'no token is left, so the reply is a push').toBe('push');
    expect(call.to).toBe(MOCK_LOGIN_LINE_USER);
    expect(call.ok).toBe(true);

    await expect.poll(usedQuota, { timeout: 20_000 }).toBe(quotaBefore + 1);
    // The allowance sits next to the composer of a LINE ticket.
    await page.reload();
    await openComposer(page, 'reply');
    await expect(
      page.getByText(new RegExp(`^${String(quotaBefore + 1)} of \\d+ used$`)),
    ).toBeVisible();
  });
});
