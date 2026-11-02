import { randomBytes } from 'node:crypto';

import { schema } from '@watchtower/db';
import { QUEUE_NAMES, STATUSPAGE_AUDIT_ACTIONS, STATUSPAGE_JOBS } from '@watchtower/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DomainError } from '../errors.js';
import { addStaff, auditRows, startDomainTest } from '../testing/support.js';
import type { DomainTestEnv } from '../testing/support.js';
import type { Actor } from '../types.js';
import { mintStatusLink } from './links.js';

// T-204a and c on a real Postgres: a draft is never public, publishing is a person's act (N3, whoever wrote
// the words), the wording from an incident takes nothing from the incident, and a subscription needs the
// owner of the address to confirm (double opt-in).
let env: DomainTestEnv;
const AI: Actor = { type: 'ai', id: 'ai-run-1' };
const SYSTEM: Actor = { type: 'system', id: null };
const ANONYMOUS: Actor = { type: 'anonymous', id: null };
const key = randomBytes(32);
const owner = () => env.db.owner.db;

beforeAll(async () => {
  env = await startDomainTest();
});
afterAll(async () => {
  await env.close();
});

async function component(slug: string, isPublic = true): Promise<string> {
  const person = await addStaff(env, 'lead');
  const { value } = await env.tx((tx) =>
    env.domain.statusPage.createComponent(tx, env.ctx(person.actor), {
      slug,
      name: `Component ${slug}`,
      description: null,
      serviceId: null,
      public: isPublic,
      position: 0,
    }),
  );
  return value.id;
}

const outboxJobs = async (name: string) =>
  (await owner().select().from(schema.outbox)).filter(
    (row) => row.queue === QUEUE_NAMES.statuspage && row.jobName === name,
  );

describe('publishing a post (N3)', () => {
  it('lets the AI draft but refuses it, and the system, the publication; a person publishes once', async () => {
    const componentId = await component('api-a');
    const drafted = await env.tx((tx) =>
      env.domain.statusPage.draftPost(tx, env.ctx(AI), {
        title: 'We are investigating an issue',
        body: 'Some requests are failing.',
        phase: 'investigating',
        impact: 'minor',
        componentIds: [componentId],
        incidentId: null,
      }),
    );
    const id = drafted.value.id;
    const [draft] = await owner()
      .select()
      .from(schema.statusPost)
      .where(eq(schema.statusPost.id, id));
    expect(draft).toMatchObject({
      state: 'draft',
      origin: 'ai',
      publishedBy: null,
      publishedAt: null,
    });

    for (const actor of [AI, SYSTEM, ANONYMOUS]) {
      await expect(
        env.tx((tx) => env.domain.statusPage.publishPost(tx, env.ctx(actor), id)),
      ).rejects.toMatchObject({ code: 'policy_denied' });
    }
    const [still] = await owner()
      .select()
      .from(schema.statusPost)
      .where(eq(schema.statusPost.id, id));
    expect(still?.state).toBe('draft');
    expect(await outboxJobs(STATUSPAGE_JOBS.notify)).toHaveLength(0);

    const lead = await addStaff(env, 'lead');
    const published = await env.tx((tx) =>
      env.domain.statusPage.publishPost(tx, env.ctx(lead.actor), id),
    );
    expect(published.value.subscribers).toBe(0);
    const [after] = await owner()
      .select()
      .from(schema.statusPost)
      .where(eq(schema.statusPost.id, id));
    expect(after).toMatchObject({ state: 'published', publishedBy: lead.id, origin: 'ai' });
    expect(after?.publishedAt).toBeInstanceOf(Date);
    const audit = (await auditRows(env, STATUSPAGE_AUDIT_ACTIONS.postPublish)).filter(
      (row) => row.targetId === id,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: 'user', actorId: lead.id });
    expect(
      (await outboxJobs(STATUSPAGE_JOBS.notify)).filter((row) => row.jobId.endsWith(id)),
    ).toHaveLength(1);

    await expect(
      env.tx((tx) => env.domain.statusPage.publishPost(tx, env.ctx(lead.actor), id)),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('lets only a person change a post that is already public, and never delete it', async () => {
    const lead = await addStaff(env, 'lead');
    const { value } = await env.tx((tx) =>
      env.domain.statusPage.draftPost(tx, env.ctx(lead.actor), {
        title: 'Title',
        body: 'Body',
        phase: 'investigating',
        impact: 'none',
        componentIds: [],
        incidentId: null,
      }),
    );
    await env.tx((tx) => env.domain.statusPage.publishPost(tx, env.ctx(lead.actor), value.id));
    await expect(
      env.tx((tx) =>
        env.domain.statusPage.updatePost(tx, env.ctx(AI), value.id, { body: 'Changed by the AI' }),
      ),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await env.tx((tx) =>
      env.domain.statusPage.updatePost(tx, env.ctx(lead.actor), value.id, { phase: 'resolved' }),
    );
    await expect(
      env.tx((tx) => env.domain.statusPage.deletePostDraft(tx, env.ctx(lead.actor), value.id)),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('writes a draft from an incident out of the template: nothing of the incident reaches the words', async () => {
    const lead = await addStaff(env, 'lead');
    const componentId = await component('checkout');
    const hiddenId = await component('hidden-one', false);
    const secret = 'Primary database failover in region xyz-internal';
    const { value: incident } = await env.tx((tx) =>
      env.domain.incidents.create(tx, env.ctx(lead.actor), {
        title: secret,
        severity: 'SEV1',
        serviceIds: [],
        alertIds: [],
        ticketIds: [],
        orgIds: [],
      }),
    );
    await owner()
      .update(schema.incident)
      .set({ rootCause: 'Bad migration of the orders table' })
      .where(eq(schema.incident.id, incident.incidentId));
    const { value } = await env.tx((tx) =>
      env.domain.statusPage.draftPostFromIncident(tx, env.ctx(lead.actor), {
        incidentId: incident.incidentId,
        componentIds: [componentId, hiddenId],
        phase: 'identified',
        impact: 'major',
        locale: 'en',
      }),
    );
    const [post] = await owner()
      .select()
      .from(schema.statusPost)
      .where(eq(schema.statusPost.id, value.id));
    expect(post?.incidentId).toBe(incident.incidentId);
    expect(post?.state).toBe('draft');
    expect(post?.body).toContain('Component checkout');
    expect(post?.body).not.toContain('Component hidden-one');
    for (const text of [post?.title ?? '', post?.body ?? '']) {
      expect(text).not.toContain('failover');
      expect(text).not.toContain('migration');
      expect(text).not.toContain('SEV');
    }
  });
});

describe('maintenance (N3)', () => {
  it('is a draft until a person publishes it; a cancelled window cannot be published', async () => {
    const lead = await addStaff(env, 'lead');
    const startsAt = new Date(Date.now() + 86_400_000).toISOString();
    const endsAt = new Date(Date.now() + 90_000_000).toISOString();
    const { value } = await env.tx((tx) =>
      env.domain.statusPage.draftMaintenance(tx, env.ctx(AI), {
        title: 'Database upgrade',
        body: 'Short interruption.',
        startsAt,
        endsAt,
        componentIds: [],
      }),
    );
    await expect(
      env.tx((tx) => env.domain.statusPage.publishMaintenance(tx, env.ctx(AI), value.id)),
    ).rejects.toBeInstanceOf(DomainError);
    await env.tx((tx) =>
      env.domain.statusPage.publishMaintenance(tx, env.ctx(lead.actor), value.id),
    );
    const [row] = await owner()
      .select()
      .from(schema.statusMaintenance)
      .where(eq(schema.statusMaintenance.id, value.id));
    expect(row).toMatchObject({ state: 'published', publishedBy: lead.id, origin: 'ai' });
    await env.tx((tx) =>
      env.domain.statusPage.cancelMaintenance(tx, env.ctx(lead.actor), value.id),
    );
    await expect(
      env.tx((tx) => env.domain.statusPage.publishMaintenance(tx, env.ctx(lead.actor), value.id)),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('subscriptions (double opt-in)', () => {
  const request = (email: string) =>
    env.tx((tx) =>
      env.domain.statusPage.requestSubscription(tx, env.ctx(ANONYMOUS), { email, locale: 'en' }),
    );
  const rowOf = async (email: string) => {
    const [row] = await owner()
      .select()
      .from(schema.statusSubscription)
      .where(eq(schema.statusSubscription.email, email));
    if (row === undefined) throw new Error('no subscription');
    return row;
  };

  it('creates a pending row and one confirmation job; an immediate repeat is throttled', async () => {
    const email = 'reader.one@example.test';
    expect((await request('Reader.One@Example.test ')).value.outcome).toBe('created');
    const row = await rowOf(email);
    expect(row.state).toBe('pending');
    expect(
      (await outboxJobs(STATUSPAGE_JOBS.confirm)).filter((job) => job.jobId.includes(row.id)),
    ).toHaveLength(1);
    expect((await request(email)).value.outcome).toBe('throttled');
    expect(
      (await outboxJobs(STATUSPAGE_JOBS.confirm)).filter((job) => job.jobId.includes(row.id)),
    ).toHaveLength(1);
    // The audit row names the subscription, never the address.
    const audit = (await auditRows(env, STATUSPAGE_AUDIT_ACTIONS.subscriptionRequest)).filter(
      (entry) => entry.targetId === row.id,
    );
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain('reader.one');
  });

  it('confirms with the link of the owner only, once or twice, and not after the window closed', async () => {
    const email = 'reader.two@example.test';
    await request(email);
    const row = await rowOf(email);
    const confirm = (token: string) =>
      env.tx((tx) => env.domain.statusPage.confirmSubscription(tx, env.ctx(ANONYMOUS), key, token));
    expect((await confirm('garbage')).value.outcome).toBe('invalid');
    expect(
      (await confirm(mintStatusLink(randomBytes(32), 'confirm', row.id, row.confirmNonce))).value
        .outcome,
    ).toBe('invalid');
    expect(
      (await confirm(mintStatusLink(key, 'confirm', row.id, '0000000000000000'))).value.outcome,
    ).toBe('invalid');
    // An unsubscribe link does not confirm.
    expect(
      (await confirm(mintStatusLink(key, 'unsubscribe', row.id, row.unsubscribeNonce))).value
        .outcome,
    ).toBe('invalid');

    // A window that closed by the database clock.
    await owner()
      .update(schema.statusSubscription)
      .set({ confirmExpiresAt: sql`clock_timestamp() - interval '1 minute'` })
      .where(eq(schema.statusSubscription.id, row.id));
    const link = mintStatusLink(key, 'confirm', row.id, row.confirmNonce);
    expect((await confirm(link)).value.outcome).toBe('invalid');
    await owner()
      .update(schema.statusSubscription)
      .set({ confirmExpiresAt: sql`clock_timestamp() + interval '1 hour'` })
      .where(eq(schema.statusSubscription.id, row.id));
    expect((await confirm(link)).value.outcome).toBe('confirmed');
    expect((await confirm(link)).value.outcome).toBe('confirmed');
    expect((await rowOf(email)).state).toBe('confirmed');
    // A confirmed address that asks again is left alone.
    expect((await request(email)).value.outcome).toBe('already_confirmed');
  });

  it('a new request kills the old link; unsubscribing is final until a new opt-in', async () => {
    const email = 'reader.three@example.test';
    await request(email);
    const first = await rowOf(email);
    await owner()
      .update(schema.statusSubscription)
      .set({ confirmationSentAt: sql`clock_timestamp() - interval '1 hour'` })
      .where(eq(schema.statusSubscription.id, first.id));
    expect((await request(email)).value.outcome).toBe('resent');
    const second = await rowOf(email);
    expect(second.confirmNonce).not.toBe(first.confirmNonce);
    const confirm = (token: string) =>
      env.tx((tx) => env.domain.statusPage.confirmSubscription(tx, env.ctx(ANONYMOUS), key, token));
    expect(
      (await confirm(mintStatusLink(key, 'confirm', first.id, first.confirmNonce))).value.outcome,
    ).toBe('invalid');
    expect(
      (await confirm(mintStatusLink(key, 'confirm', second.id, second.confirmNonce))).value.outcome,
    ).toBe('confirmed');

    const unsubscribe = (token: string) =>
      env.tx((tx) => env.domain.statusPage.unsubscribe(tx, env.ctx(ANONYMOUS), key, token));
    const oldUnsubscribe = mintStatusLink(key, 'unsubscribe', second.id, second.unsubscribeNonce);
    expect((await unsubscribe(oldUnsubscribe)).value.outcome).toBe('unsubscribed');
    expect((await unsubscribe(oldUnsubscribe)).value.outcome).toBe('unsubscribed');
    expect((await rowOf(email)).state).toBe('unsubscribed');
    // Coming back needs a new opt-in and invalidates the old unsubscribe link.
    expect((await request(email)).value.outcome).toBe('reactivated');
    const back = await rowOf(email);
    expect(back.state).toBe('pending');
    expect((await unsubscribe(oldUnsubscribe)).value.outcome).toBe('invalid');
    expect(
      await owner()
        .select()
        .from(schema.statusSubscription)
        .where(
          and(
            eq(schema.statusSubscription.id, back.id),
            eq(schema.statusSubscription.state, 'pending'),
          ),
        ),
    ).toHaveLength(1);
  });
});
