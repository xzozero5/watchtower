import type { Browser, BrowserContext, Page } from '@playwright/test';

import {
  alertmanagerBody,
  Api,
  buttonIds,
  discordCalls,
  expect,
  fakeGmail,
  gmailSends,
  Mailbox,
  newActor,
  ORGS,
  postAlertWebhook,
  signInDev,
  type StaffTicket,
  test,
  unique,
} from './support';

/**
 * PRD scenario 5.3 ("A GCP alert fires"), the half after the alert: alert -> incident -> Discord thread (mock)
 * -> status page draft, then publish -> mass customer communication -> resolve. Real api, worker, web and database;
 * alerts come through the signed webhook, Discord is the worker's recording in-memory bot, mail is the in-memory
 * Gmail and Mailpit. Nothing leaves the machine.
 *
 * What it pins down:
 *  - an incident made from an alert links the alert; the alert is not resolved by it, and when the monitoring
 *    tool later says "resolved" the alert closes but the incident stays open until a person closes it (PRD 5.3)
 *  - the incident gets a Discord thread: here a mock (`discordThreadState: mock`), never shown as created; the
 *    opening message holds the incident key and an Ack button and no incident title (N4); key timeline entries
 *    are mirrored into the thread
 *  - a status post for the incident starts as a draft that nobody outside sees; an agent may draft but only a
 *    person with `incident.manage` publishes (N3); publishing makes it public and mails the confirmed subscriber
 *  - the customer update is drafted, previewed (count of recipients), sent only with that count confirmed, and
 *    reaches the affected customer's mail thread
 *  - resolving the incident and the status post puts the page back to operational
 */
test.describe
  .serial('Scenario 5.3: alert -> incident -> thread -> status page -> mass comms -> resolve', () => {
  let lead: Person;
  let agent: Person;
  let visitor: { context: BrowserContext; page: Page };
  const slug = unique('svc').replace(/_/g, '-');
  const alertname = unique('CheckoutErrors');
  const fingerprint = unique('fp').replace(/-/g, '');
  const incidentTitle = `Checkout failing ${unique('inc')}`;
  const subscriber = new Mailbox(`${unique('e2e-sub')}@subscriber.example.net`);
  const customerThread = unique('thread');
  const customerSubject = `Checkout is failing ${unique('c')}`;
  const customer = `${unique('ops')}@${ORGS.acme.domain}`;
  const postTitle = `Checkout is degraded ${unique('post')}`;

  let serviceId = '';
  let componentId = '';
  let alertId = '';
  let incident: IncidentJson;
  let ticket: StaffTicket;
  let postId = '';

  interface Person {
    context: BrowserContext;
    page: Page;
    api: Api;
  }
  interface IncidentJson {
    id: string;
    key: string;
    status: string;
    discordThreadState: string;
    alerts?: number;
    tickets?: number;
  }
  interface AlertJson {
    id: string;
    state: string;
    incidentId: string | null;
  }

  async function person(browser: Browser, role: 'head' | 'lead' | 'agent'): Promise<Person> {
    const { context, page } = await newActor(browser);
    await signInDev(page, role, unique(role));
    return { context, page, api: new Api(context.request) };
  }
  const publicStatus = async () => {
    const response = await visitor.context.request.get(
      new URL('/v1/status', process.env.E2E_API_URL).toString(),
    );
    expect(response.status()).toBe(200);
    return (await response.json()) as {
      overall: string;
      components: { slug: string; status: string }[];
      activePosts: { id: string; title: string }[];
    };
  };

  test.beforeAll(async ({ browser }) => {
    lead = await person(browser, 'lead');
    agent = await person(browser, 'agent');
    visitor = await newActor(browser);
  });

  test.afterAll(async () => {
    await subscriber.delete();
    for (const who of [lead, agent, visitor]) await who.context.close();
  });

  test('setup: a connected mailbox, a service, its public status component and a confirmed status subscriber', async ({
    browser,
  }) => {
    // A reply (and so a customer update) leaves through a connected Gmail account (`channel_not_connected`
    // otherwise). The head registers one unless an earlier file of this run already did.
    const head = await person(browser, 'head');
    try {
      const accounts = await head.api.get<{ items: { type: string }[] }>(
        '/v1/admin/channel-accounts',
      );
      if (!accounts.json.items.some((account) => account.type === 'gmail')) {
        const mailbox = await head.api.post('/v1/admin/channel-accounts', {
          type: 'gmail',
          name: 'Fake Gmail mailbox (test)',
          emailAddress: `support-${unique('inc')}@mail.example.test`,
        });
        expect(mailbox.status).toBe(201);
      }
    } finally {
      await head.context.close();
    }

    const service = await lead.api.post<{ id: string }>('/v1/services', {
      slug,
      name: `Checkout ${slug}`,
      matchRules: [{ labels: { service: slug } }],
    });
    expect(service.status).toBe(201);
    serviceId = service.json.id;
    const component = await lead.api.post<{ id: string }>('/v1/status-page/components', {
      slug: `web-${slug}`,
      name: `Checkout web ${slug}`,
      serviceId,
      public: true,
    });
    expect(component.status).toBe(201);
    componentId = component.json.id;

    // A visitor subscribes on the public page and confirms from the emailed link.
    await visitor.page.goto('/status');
    await visitor.page.getByLabel('Email address').fill(subscriber.address);
    await visitor.page.getByRole('button', { name: 'Subscribe' }).click();
    await expect(visitor.page.getByText('Check your email')).toBeVisible();
    const confirm = await subscriber.next(/Confirm your subscription/);
    await visitor.page.goto(confirm.link);
    await visitor.page.getByRole('button', { name: 'Confirm subscription' }).click();
    await expect(visitor.page.getByText('You are subscribed.')).toBeVisible();

    const before = await publicStatus();
    expect(before.activePosts.map((post) => post.title)).not.toContain(postTitle);
  });

  test('an alert fires and opens; the monitoring tool is one signed notification away', async () => {
    const fired = await postAlertWebhook(
      alertmanagerBody({ alertname, fingerprint, labels: { service: slug } }),
    );
    expect(fired).toMatchObject({ status: 200, json: { accepted: 1 } });
    const alerts = await lead.api.all<AlertJson>(`/v1/alerts?serviceId=${serviceId}`);
    expect(alerts).toHaveLength(1);
    alertId = alerts[0]?.id ?? '';
    expect(alerts[0]).toMatchObject({ state: 'open', incidentId: null });
  });

  test('an affected customer writes in; the lead opens an incident from the alert and links the ticket', async () => {
    fakeGmail({
      from: customer,
      subject: customerSubject,
      body: 'Our customers cannot pay: the checkout shows an error since a few minutes.',
      threadId: customerThread,
    });
    await expect
      .poll(
        async () => {
          const all = await lead.api.all<StaffTicket>('/v1/tickets');
          const found = all.find((candidate) => candidate.subject === customerSubject);
          if (found) ticket = found;
          return found !== undefined;
        },
        { message: 'the customer mail became a ticket' },
      )
      .toBe(true);

    const created = await lead.api.post<IncidentJson>('/v1/incidents', {
      title: incidentTitle,
      severity: 'SEV2',
      serviceIds: [serviceId],
      alertIds: [alertId],
    });
    expect(created.status).toBe(201);
    incident = created.json;
    expect(incident.key).toMatch(/^INC-\d+$/);
    expect(incident.status).toBe('investigating');

    const linked = await lead.api.post(`/v1/incidents/${incident.id}/tickets`, {
      ticketId: ticket.id,
    });
    expect(linked.status).toBeLessThan(300);

    const detail = await lead.api.get<{
      alertIds: string[];
      ticketIds: string[];
      orgIds: string[];
    }>(`/v1/incidents/${incident.id}`);
    expect(detail.json.alertIds).toEqual([alertId]);
    expect(detail.json.ticketIds).toEqual([ticket.id]);
    expect(detail.json.orgIds, "the ticket's organization is affected").toContain(ticket.org.id);
    expect((await lead.api.get<AlertJson>(`/v1/alerts/${alertId}`)).json.incidentId).toBe(
      incident.id,
    );
  });

  test('the worker opens the Discord thread (a mock, said so) and mirrors key timeline entries into it', async () => {
    await expect
      .poll(
        async () =>
          (await lead.api.get<IncidentJson>(`/v1/incidents/${incident.id}`)).json
            .discordThreadState,
        { message: 'the incident thread was handled by the worker' },
      )
      .toBe('mock');

    const opening = discordCalls().find(
      (call) =>
        call.op === 'postMessage' && buttonIds(call).includes(`incident:ack:${incident.id}`),
    );
    expect(opening, 'the opening message has the Ack button').toBeDefined();
    expect(opening?.payload.content).toContain(incident.key);
    expect(opening?.payload.content, 'the incident title stays in the app (N4)').not.toContain(
      incidentTitle,
    );
    expect(buttonIds(opening ?? { op: 'postMessage', target: '', payload: {}, at: 0 })).toContain(
      `incident:assign:${incident.id}`,
    );
    expect(
      discordCalls().some(
        (call) => call.op === 'createThread' && call.payload.name?.includes(incident.key),
      ),
      'a thread named after the incident key',
    ).toBe(true);

    // A key change (severity) is mirrored as a line in the thread; its words come from the type, not from the title.
    const changed = await lead.api.patch(`/v1/incidents/${incident.id}`, { severity: 'SEV1' });
    expect(changed.status).toBe(200);
    await expect
      .poll(
        () =>
          discordCalls().some(
            (call) =>
              call.op === 'postInThread' &&
              call.target.includes(incident.id) &&
              (call.payload.content ?? '').includes(incident.key) &&
              (call.payload.content ?? '').includes('SEV1'),
          ),
        { message: 'the severity change is mirrored into the thread' },
      )
      .toBe(true);
  });

  test('a status post starts as a draft nobody outside sees; an agent cannot publish it, the lead can', async () => {
    const draft = await agent.api.post<{ id: string; state: string; origin: string }>(
      '/v1/status-page/posts/from-incident',
      {
        incidentId: incident.id,
        componentIds: [componentId],
        phase: 'investigating',
        impact: 'major',
      },
    );
    expect(draft.status).toBe(201);
    expect(draft.json.state).toBe('draft');
    postId = draft.json.id;
    const edited = await agent.api.patch(`/v1/status-page/posts/${postId}`, {
      title: postTitle,
      body: 'Some customers cannot complete a payment. We are investigating.',
    });
    expect(edited.status).toBe(200);

    expect(
      (await publicStatus()).activePosts.map((post) => post.id),
      'a draft is not public',
    ).not.toContain(postId);
    expect((await agent.api.post(`/v1/status-page/posts/${postId}/publish`)).status).toBe(403);
    expect((await publicStatus()).activePosts.map((post) => post.id)).not.toContain(postId);

    const published = await lead.api.post<{ post: { state: string }; subscribers: number }>(
      `/v1/status-page/posts/${postId}/publish`,
    );
    expect(published.status).toBe(200);
    expect(published.json.post.state).toBe('published');
    expect(published.json.subscribers).toBeGreaterThanOrEqual(1);

    // The component shows the outage; the public page and the subscriber both hear of it.
    expect(
      (
        await lead.api.patch(`/v1/status-page/components/${componentId}`, {
          status: 'major_outage',
        })
      ).status,
    ).toBe(200);
    const status = await publicStatus();
    expect(status.activePosts.map((post) => post.id)).toContain(postId);
    expect(status.overall).toBe('outage');

    await visitor.page.goto('/status');
    await expect(visitor.page.getByText(postTitle).first()).toBeVisible();
    const mail = await subscriber.next(new RegExp(postTitle.slice(0, 20)));
    expect(mail.subject).toBe(postTitle);
  });

  test("mass communication: drafted, counted, sent only with the count confirmed, and it reaches the customer's thread", async () => {
    const preview = await lead.api.get<{ recipients: number }>(
      `/v1/incidents/${incident.id}/comms/preview`,
    );
    expect(preview.json.recipients).toBe(1);

    const draft = await lead.api.post<{ id: string; status: string }>(
      `/v1/incidents/${incident.id}/comms`,
      {
        body: 'We are aware of the checkout problem and are working on it. We will write again within the hour.',
      },
    );
    expect(draft.status).toBe(201);
    expect(draft.json.status).toBe('draft');
    const sendsBefore = gmailSends().length;

    // The audience the person saw (1) must match the audience now: a stale count is refused, nothing goes out.
    const stale = await lead.api.post(`/v1/incidents/${incident.id}/comms/${draft.json.id}/send`, {
      confirmRecipients: 5,
    });
    expect(stale.status).toBe(409);
    expect(gmailSends()).toHaveLength(sendsBefore);

    const sent = await lead.api.post<{ recipients: number; sent: number; failed: number }>(
      `/v1/incidents/${incident.id}/comms/${draft.json.id}/send`,
      { confirmRecipients: 1 },
    );
    expect(sent.status).toBeLessThan(300);
    expect(sent.json).toMatchObject({ recipients: 1, sent: 1, failed: 0 });

    await expect
      .poll(() => gmailSends().filter((send) => send.requestedThreadId === customerThread).length, {
        message: "the update went out into the customer's mail thread",
      })
      .toBeGreaterThan(0);
  });

  test('resolve: the monitoring tool closes the alert, the incident stays open until a person closes it, then the page is operational', async () => {
    const closed = await postAlertWebhook(
      alertmanagerBody({ alertname, fingerprint, status: 'resolved', labels: { service: slug } }),
    );
    expect(closed).toMatchObject({ status: 200, json: { accepted: 1 } });
    expect((await lead.api.get<AlertJson>(`/v1/alerts/${alertId}`)).json.state).toBe('resolved');
    expect(
      (await lead.api.get<IncidentJson>(`/v1/incidents/${incident.id}`)).json.status,
      'the incident does not close by itself (PRD 5.3)',
    ).not.toBe('resolved');

    const resolved = await lead.api.patch<IncidentJson>(`/v1/incidents/${incident.id}`, {
      status: 'resolved',
      rootCause: 'A bad configuration of the payment provider was rolled back.',
    });
    expect(resolved.status).toBe(200);
    expect(resolved.json.status).toBe('resolved');

    expect(
      (
        await lead.api.patch(`/v1/status-page/posts/${postId}`, {
          phase: 'resolved',
          body: 'Payments work again.',
        })
      ).status,
    ).toBe(200);
    expect(
      (await lead.api.patch(`/v1/status-page/components/${componentId}`, { status: 'operational' }))
        .status,
    ).toBe(200);
    const status = await publicStatus();
    expect(
      status.activePosts.map((post) => post.id),
      'a resolved post leaves the active list',
    ).not.toContain(postId);
    expect(status.components.find((component) => component.slug === `web-${slug}`)?.status).toBe(
      'operational',
    );

    const detail = await lead.api.get<{ timeline: { type: string }[] }>(
      `/v1/incidents/${incident.id}`,
    );
    const types = detail.json.timeline.map((entry) => entry.type);
    for (const type of ['created', 'thread_created', 'comms_sent', 'status_changed']) {
      expect(types, `the timeline has ${type}`).toContain(type);
    }
    await expect
      .poll(
        () =>
          discordCalls().some(
            (call) =>
              call.op === 'postInThread' &&
              call.target.includes(incident.id) &&
              /resolved/i.test(call.payload.content ?? ''),
          ),
        { message: 'the resolution is mirrored into the thread' },
      )
      .toBe(true);
  });
});
