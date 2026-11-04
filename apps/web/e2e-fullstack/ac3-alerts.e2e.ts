import type { Browser, BrowserContext, Page } from '@playwright/test';

import {
  alertmanagerBody,
  Api,
  buttonIds,
  discordCalls,
  expect,
  linkDiscordAccount,
  newActor,
  nextSnowflake,
  postAlertWebhook,
  pressDiscordButton,
  signInDev,
  stack,
  test,
  unique,
} from './support';

/**
 * AC-3 (PRD section 4.3) and the alert half of scenario 5.3, with the real api, worker, web and database and
 * the stack's mock integrations: the machine-alert webhook (signed with the secret of the run), the in-memory
 * Discord bot of the worker (tools/e2e-stack/worker-runner.mjs records every call it would have made) and the
 * Discord interactions endpoint (signed with the private half of the run's Ed25519 key pair).
 *
 *  1. The same alert fired twice inside 5 minutes is one alert with count 2; a redelivery of a notification is
 *     not a third fire.
 *  2. Nobody acknowledges it: after T1 the escalation tells the lead in Discord, with an Ack button.
 *  3. Somebody presses Ack in Discord (an unlinked account first: refused, nothing changes). The web, open on
 *     that alert, shows it acknowledged within 2 s of the press (measured).
 *
 * T1 is made short (20 s) in a policy of this test, so the wait is the escalation sweep (15 s), not 5 minutes.
 * The policy and the service exist only in this run's throwaway database.
 */
const WEB_UPDATE_BUDGET_MS = 2_000;
const T1_SECONDS = 20;

interface AlertJson {
  id: string;
  state: string;
  count: number;
  title: string;
  ackedVia: string | null;
  ackedBy: string | null;
  escalationLevel: number;
  nextEscalationAt: string | null;
  serviceId: string | null;
}
interface EscalationJson {
  level: number;
  target: string;
  chatState: string;
}
interface Person {
  context: BrowserContext;
  page: Page;
  api: Api;
  id: string;
}

test.describe.serial('AC-3: dedupe, escalate after T1, acknowledge in Discord', () => {
  let head: Person;
  let lead: Person;
  let serviceId = '';
  let alertId = '';
  const slug = unique('svc').replace(/_/g, '-');
  const alertname = unique('HighErrorRate');
  const fingerprint = unique('fp').replace(/-/g, '');
  const leadDiscordId = nextSnowflake();
  const strangerDiscordId = nextSnowflake();

  async function person(browser: Browser, role: 'head' | 'lead') {
    const { context, page } = await newActor(browser);
    await signInDev(page, role, unique(role));
    const api = new Api(context.request);
    const session = await api.get<{ user: { id: string } }>('/v1/auth/session');
    return { context, page, api, id: session.json.user.id };
  }

  const alertsOfService = () => head.api.all<AlertJson>(`/v1/alerts?serviceId=${serviceId}`);

  test.beforeAll(async ({ browser }) => {
    head = await person(browser, 'head');
    lead = await person(browser, 'lead');
    linkDiscordAccount(lead.id, leadDiscordId);
  });

  test.afterAll(async () => {
    for (const who of [head, lead]) await who.context.close();
  });

  test('setup: a service with a short escalation policy claims the alerts of this test', async () => {
    const policy = await head.api.post<{ id: string }>('/v1/escalation-policies', {
      name: `ac3 ${slug}`,
      steps: [
        { target: 'on_shift', afterSeconds: 0 },
        { target: 'lead', afterSeconds: T1_SECONDS },
        { target: 'head', afterSeconds: 300 },
      ],
    });
    expect(policy.status).toBe(201);
    const service = await head.api.post<{ id: string }>('/v1/services', {
      slug,
      name: `AC3 service ${slug}`,
      matchRules: [{ labels: { service: slug } }],
      escalationPolicyId: policy.json.id,
    });
    expect(service.status).toBe(201);
    serviceId = service.json.id;
  });

  test('the same alert fired twice within 5 minutes is one alert with count 2', async () => {
    const first = await postAlertWebhook(
      alertmanagerBody({
        alertname,
        fingerprint,
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        labels: { service: slug },
      }),
    );
    expect(first).toMatchObject({ status: 200, json: { accepted: 1, duplicates: 0 } });

    const secondBody = alertmanagerBody({
      alertname,
      fingerprint,
      startsAt: new Date().toISOString(),
      labels: { service: slug },
    });
    const second = await postAlertWebhook(secondBody);
    expect(second).toMatchObject({ status: 200, json: { accepted: 1, duplicates: 0 } });

    // The same notification delivered again is a redelivery, not a third fire.
    const redelivery = await postAlertWebhook(secondBody);
    expect(redelivery).toMatchObject({ status: 200, json: { accepted: 0, duplicates: 1 } });

    const alerts = await alertsOfService();
    expect(alerts, 'one alert, not two').toHaveLength(1);
    expect(alerts[0]?.count).toBe(2);
    expect(alerts[0]?.state).toBe('open');
    alertId = alerts[0]?.id ?? '';
  });

  test('a notification with a wrong signature is refused and opens nothing', async () => {
    const body = alertmanagerBody({
      alertname: unique('Forged'),
      fingerprint: unique('fp'),
      labels: { service: slug },
    });
    const response = await fetch(new URL('/v1/inbound/alerts/webhook', stack().apiUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-watchtower-signature': `t=${String(Math.floor(Date.now() / 1000))},v1=${'0'.repeat(64)}`,
      },
      body,
    });
    expect(response.status).toBe(401);
    expect(await alertsOfService()).toHaveLength(1);
  });

  test('not acknowledged within T1: the lead is told in Discord with an Ack button', async () => {
    // The escalation sweep runs every 15 s, so allow T1 plus a few sweeps.
    await expect
      .poll(
        async () => {
          const steps = await head.api.get<{ items: EscalationJson[] }>(
            `/v1/alerts/${alertId}/escalations`,
          );
          return steps.json.items.some((step) => step.target === 'lead');
        },
        { message: 'the lead step ran', timeout: 90_000, intervals: [1_000] },
      )
      .toBe(true);

    // The step row exists before the chat post is made (`pending`/`sending`); the post settles as `mock`:
    // the in-memory bot recorded the page and nothing left the process (never reported as sent).
    await expect
      .poll(
        async () => {
          const steps = await head.api.get<{ items: EscalationJson[] }>(
            `/v1/alerts/${alertId}/escalations`,
          );
          return steps.json.items.find((step) => step.target === 'lead');
        },
        { message: 'the lead step settles as mock' },
      )
      .toMatchObject({ level: 1, chatState: 'mock' });

    await expect
      .poll(
        () =>
          discordCalls().some(
            (call) =>
              call.op === 'postMessage' &&
              buttonIds(call).includes(`alert:ack:${alertId}`) &&
              call.payload.content?.includes('step 2: lead') === true,
          ),
        { message: 'a Discord page for step 2 (the lead) with the Ack button' },
      )
      .toBe(true);

    const page = discordCalls().find(
      (call) => call.op === 'postMessage' && call.payload.content?.includes('step 2: lead'),
    );
    expect(page?.payload.content, 'the page says how many times it fired').toContain('fired 2x');
    expect(page?.payload.content, 'no alert title or label values in chat (N4)').not.toContain(
      alertname,
    );
    const stillOpen = (await head.api.get<AlertJson>(`/v1/alerts/${alertId}`)).json;
    expect(stillOpen.state).toBe('open');
    expect(stillOpen.nextEscalationAt, 'the head step (T2) is still ahead').not.toBeNull();
  });

  test('an unlinked Discord account is refused; a linked one acknowledges and the web shows it within 2 s', async () => {
    await lead.page.goto(`/alerts?alert=${alertId}`);
    await expect(
      lead.page.locator('[data-testid="live-status"][data-state="open"]'),
    ).toBeAttached();
    await expect(lead.page.getByText('Step 2: The lead')).toBeVisible();
    await expect(lead.page.getByText(/Acknowledged via/)).toHaveCount(0);

    const stranger = await pressDiscordButton(strangerDiscordId, `alert:ack:${alertId}`);
    expect(stranger.status).toBe(200);
    expect(stranger.json?.data?.content).toContain('not linked');
    expect((await head.api.get<AlertJson>(`/v1/alerts/${alertId}`)).json.state).toBe('open');

    const startedAt = Date.now();
    const [pressed] = await Promise.all([
      pressDiscordButton(leadDiscordId, `alert:ack:${alertId}`),
      expect(lead.page.getByText('Acknowledged via Discord')).toBeVisible({
        timeout: WEB_UPDATE_BUDGET_MS,
      }),
    ]);
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `[AC-3] Ack pressed in Discord -> shown in the open web page: ${String(elapsedMs)} ms (budget ${String(WEB_UPDATE_BUDGET_MS)} ms)`,
    );
    test
      .info()
      .annotations.push({ type: 'AC-3 Discord ack to web (ms)', description: String(elapsedMs) });
    expect(pressed.status).toBe(200);
    expect(elapsedMs).toBeLessThan(WEB_UPDATE_BUDGET_MS);

    const alert = (await head.api.get<AlertJson>(`/v1/alerts/${alertId}`)).json;
    expect(alert).toMatchObject({ state: 'acknowledged', ackedVia: 'discord', ackedBy: lead.id });

    // The same interaction delivered twice is handled once.
    const again = await pressDiscordButton(leadDiscordId, `alert:ack:${alertId}`, {
      interactionId: nextSnowflake(),
    });
    expect(again.status).toBe(200);
    expect((await head.api.get<AlertJson>(`/v1/alerts/${alertId}`)).json.ackedBy).toBe(lead.id);
  });

  test('once acknowledged the escalation stops: no further step is due', async () => {
    const alert = (await head.api.get<AlertJson>(`/v1/alerts/${alertId}`)).json;
    expect(alert.nextEscalationAt, 'the head step (T2) is no longer scheduled').toBeNull();
    expect(alert.escalationLevel).toBe(2);
    const steps = await head.api.get<{ items: EscalationJson[] }>(
      `/v1/alerts/${alertId}/escalations`,
    );
    expect(steps.json.items.map((step) => step.target)).not.toContain('head');
  });
});
