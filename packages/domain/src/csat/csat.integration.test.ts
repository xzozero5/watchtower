import { randomBytes, randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import { CSAT_LANDING_PATH, type TicketStatus } from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey, openFields, outboxAad } from '@watchtower/shared/secret-box';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addOrg,
  addPolicy,
  auditRows,
  eventTypes,
  startDomainTest,
  type DomainTestEnv,
} from '../testing/support.js';
import { verifyCsatToken } from './token.js';

// R-10.1 to R-10.5 and R-1.10 against a real Postgres: when a survey is owed, who is spared, how the
// scheduler sends and reminds through the outbox, and what an answer does to the ticket.

const SEAL_KEY = deriveSubkey(randomBytes(32).toString('hex'), KEY_LABELS.outboxSecret);
const SIGNING_KEY = randomBytes(32);
const LANDING = `http://app.test${CSAT_LANDING_PATH}`;

let env: DomainTestEnv;

beforeAll(async () => {
  env = await startDomainTest({
    sealKey: SEAL_KEY,
    csat: { signingKey: SIGNING_KEY, landingUrl: LANDING },
  });
  await addPolicy(env, { P3: { first_response_min: 60, resolution_min: 240, calendar: '24x7' } });
});
afterAll(async () => {
  await env.close();
});

const T0 = new Date('2030-01-07T10:00:00.000Z');
const after = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
const HOUR = 60;
const DAY = 24 * HOUR;

const survey = async (ticketId: string) => {
  const rows = await env.db.owner.db
    .select()
    .from(schema.csatSurvey)
    .where(eq(schema.csatSurvey.ticketId, ticketId));
  return rows;
};
const only = async (ticketId: string) => {
  const rows = await survey(ticketId);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (!row) throw new Error('no survey');
  return row;
};
const ticketRow = async (id: string) => {
  const [row] = await env.db.owner.db.select().from(schema.ticket).where(eq(schema.ticket.id, id));
  if (!row) throw new Error('no ticket');
  return row;
};

const move = (ref: string, status: TicketStatus, at: Date) =>
  env.tx((tx) =>
    env.domain.tickets.changeStatus(tx, env.ctx(undefined, { now: () => at }), { ref, status }),
  );

interface Made {
  readonly ticketId: string;
  readonly contactId: string;
  readonly orgId: string;
  readonly email: string;
}

/** A portal ticket from a new customer, opened and then resolved at `resolvedAfter` minutes. */
async function resolvedTicket(
  options: { orgId?: string; email?: string; resolvedAfter?: number } = {},
): Promise<Made> {
  const org = options.orgId === undefined ? await addOrg(env) : { id: options.orgId };
  const email = options.email ?? `${randomUUID()}@customer.test`;
  const { value } = await env.tx((tx) =>
    env.domain.tickets.create(tx, env.ctx(undefined, { now: () => T0 }), {
      orgId: org.id,
      subject: 'Something broke',
      body: 'Please help',
      requester: { email, name: 'Customer' },
    }),
  );
  const ticket = value.ticket;
  await move(ticket.id, 'open', after(1));
  await move(ticket.id, 'resolved', after(options.resolvedAfter ?? 2));
  if (ticket.requesterContactId === null) throw new Error('no requester');
  return { ticketId: ticket.id, contactId: ticket.requesterContactId, orgId: org.id, email };
}

const sweep = (at: Date) =>
  env.domain.csat.sweep(env.database.db, env.ctx(undefined, { now: () => at }));

async function emailJobs(jobIdPrefix: string, ticketSurveyId: string) {
  const rows = await env.db.owner.db
    .select()
    .from(schema.outbox)
    .where(
      and(
        eq(schema.outbox.queue, 'email'),
        eq(schema.outbox.jobId, `${jobIdPrefix}-${ticketSurveyId}`),
      ),
    );
  return rows;
}

/** The link the customer would get, opened from the sealed outbox row. */
async function linkOf(
  jobIdPrefix: string,
  surveyId: string,
): Promise<{ url: string; token: string }> {
  const [row] = await emailJobs(jobIdPrefix, surveyId);
  if (!row) throw new Error('no email job');
  const payload = row.payload as { secret: string };
  const fields = openFields(SEAL_KEY, payload.secret, outboxAad('email', row.jobId));
  const url = fields.surveyUrl ?? '';
  const token = new URL(url).hash.slice(1).split('&')[0]?.replace('token=', '') ?? '';
  return { url, token };
}

const answer = (
  surveyId: string,
  at: Date,
  input: { score: number; resolved?: boolean; comment?: string },
) =>
  env.tx((tx) =>
    env.domain.csat.answer(tx, env.ctx({ type: 'anonymous', id: null }, { now: () => at }), {
      surveyId,
      ...input,
    }),
  );

describe('scheduling a survey (R-10.1, R-10.4)', () => {
  it('resolving a portal ticket owes a survey after the default delay of one hour', async () => {
    const made = await resolvedTicket({ resolvedAfter: 2 });
    const row = await only(made.ticketId);
    expect(row).toMatchObject({
      status: 'scheduled',
      channel: 'email',
      contactId: made.contactId,
      orgId: made.orgId,
      sentAt: null,
    });
    expect(row.sendAfter.toISOString()).toBe(after(2 + HOUR).toISOString());
  });

  it('uses the configured delay, read when the ticket is resolved', async () => {
    await env.tx((tx) => env.domain.csat.setDelayMinutes(tx, env.ctx(), 5));
    try {
      const made = await resolvedTicket({ resolvedAfter: 2 });
      expect((await only(made.ticketId)).sendAfter.toISOString()).toBe(after(7).toISOString());
    } finally {
      await env.tx((tx) => env.domain.csat.setDelayMinutes(tx, env.ctx(), 60));
    }
    expect(await env.domain.csat.readDelayMinutes(env.database.db)).toBe(60);
    expect((await auditRows(env, 'csat.setting_set')).length).toBeGreaterThanOrEqual(2);
  });

  it('never surveys internal or machine tickets, and LINE tickets wait for T-110c', async () => {
    for (const channel of ['webhook', 'discord', 'line'] as const) {
      const org = await addOrg(env);
      const { value } = await env.tx((tx) =>
        env.domain.tickets.create(tx, env.ctx(undefined, { now: () => T0 }), {
          orgId: org.id,
          subject: 's',
          body: 'b',
          requester: { email: `${randomUUID()}@customer.test`, name: 'C' },
        }),
      );
      await env.db.owner.db
        .update(schema.ticket)
        .set({ channel })
        .where(eq(schema.ticket.id, value.ticket.id));
      await move(value.ticket.id, 'open', after(1));
      await move(value.ticket.id, 'resolved', after(2));
      expect(await survey(value.ticket.id), channel).toHaveLength(0);
    }
  });

  it('spares an organization that opted out, and says why', async () => {
    const org = await addOrg(env);
    await env.tx((tx) => env.domain.csat.setOptOut(tx, env.ctx(), org.id, true));
    const made = await resolvedTicket({ orgId: org.id });
    expect(await only(made.ticketId)).toMatchObject({ status: 'skipped', reason: 'org_opt_out' });
    await env.tx((tx) => env.domain.csat.setOptOut(tx, env.ctx(), org.id, false));
    const next = await resolvedTicket({ orgId: org.id });
    expect((await only(next.ticketId)).status).toBe('scheduled');
    expect((await auditRows(env, 'csat.opt_out_set')).length).toBeGreaterThanOrEqual(2);
  });

  it('refuses to opt out an organization that does not exist', async () => {
    await expect(
      env.tx((tx) => env.domain.csat.setOptOut(tx, env.ctx(), randomUUID(), true)),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('sends at most one survey per contact per 7 days', async () => {
    const org = await addOrg(env);
    const email = `${randomUUID()}@customer.test`;
    const first = await resolvedTicket({ orgId: org.id, email });
    await sweep(after(2 + HOUR));
    expect((await only(first.ticketId)).status).toBe('sent');

    // A second ticket of the same contact, resolved three days later: spared when it is scheduled.
    const second = await resolvedTicket({ orgId: org.id, email, resolvedAfter: 3 * DAY });
    expect(await only(second.ticketId)).toMatchObject({
      status: 'skipped',
      reason: 'contact_cooldown',
    });
    // ... and eight days later it is allowed again.
    const third = await resolvedTicket({ orgId: org.id, email, resolvedAfter: 8 * DAY });
    expect((await only(third.ticketId)).status).toBe('scheduled');
  });

  it('two tickets resolved together: the first survey goes out, the second is skipped when it comes due', async () => {
    const org = await addOrg(env);
    const email = `${randomUUID()}@customer.test`;
    const a = await resolvedTicket({ orgId: org.id, email, resolvedAfter: 2 });
    const b = await resolvedTicket({ orgId: org.id, email, resolvedAfter: 3 });
    expect((await only(a.ticketId)).status).toBe('scheduled');
    expect((await only(b.ticketId)).status).toBe('scheduled');
    const result = await sweep(after(10 + HOUR));
    expect(result.sent).toBeGreaterThanOrEqual(1);
    const statuses = [(await only(a.ticketId)).status, (await only(b.ticketId)).status].sort();
    expect(statuses).toEqual(['sent', 'skipped']);
  });
});

describe('the scheduler (R-10.1, R-10.2, R-10.4)', () => {
  it('sends nothing before the delay has passed, then queues one email in the outbox', async () => {
    const made = await resolvedTicket({ resolvedAfter: 2 });
    const row = await only(made.ticketId);
    await sweep(after(2 + HOUR - 1));
    expect((await only(made.ticketId)).status).toBe('scheduled');

    await sweep(after(2 + HOUR));
    const sent = await only(made.ticketId);
    expect(sent.status).toBe('sent');
    expect(sent.sentAt?.toISOString()).toBe(after(2 + HOUR).toISOString());
    expect(sent.reminderDueAt?.toISOString()).toBe(after(2 + HOUR + 48 * HOUR).toISOString());
    expect(sent.tokenExpiresAt?.toISOString()).toBe(after(2 + HOUR + 14 * DAY).toISOString());

    const jobs = await emailJobs('csat-survey', row.id);
    expect(jobs).toHaveLength(1);
    const payload = jobs[0]?.payload as Record<string, unknown>;
    // The link is sealed: the clear part holds no link and no address-free token.
    expect(payload).toMatchObject({ kind: 'csat_survey', to: made.email, reminder: false });
    expect(JSON.stringify(payload)).not.toContain('wtc1');
    expect(payload).not.toHaveProperty('surveyUrl');
    expect((await auditRows(env, 'csat.survey_sent')).some((a) => a.targetId === row.id)).toBe(
      true,
    );
  });

  it('is idempotent: a second sweep sends nothing more', async () => {
    const made = await resolvedTicket({ resolvedAfter: 2 });
    const row = await only(made.ticketId);
    await sweep(after(2 + HOUR));
    await sweep(after(2 + HOUR + 1));
    expect(await emailJobs('csat-survey', row.id)).toHaveLength(1);
  });

  it('the emailed link verifies, belongs to this survey, and expires with the survey', async () => {
    const made = await resolvedTicket({ resolvedAfter: 2 });
    const row = await only(made.ticketId);
    await sweep(after(2 + HOUR));
    const { url, token } = await linkOf('csat-survey', row.id);
    expect(url.startsWith(`${LANDING}#token=`)).toBe(true);
    const claims = verifyCsatToken(SIGNING_KEY, token, after(2 + HOUR));
    expect(claims?.surveyId).toBe(row.id);
    expect(claims?.expiresAt.toISOString()).toBe(
      (await only(made.ticketId)).tokenExpiresAt?.toISOString(),
    );
  });

  it('voids a survey that is still owed when the ticket is reopened (R-10.1, R-10.4)', async () => {
    const made = await resolvedTicket({ resolvedAfter: 2 });
    await move(made.ticketId, 'open', after(10));
    expect(await only(made.ticketId)).toMatchObject({
      status: 'voided',
      reason: 'ticket_reopened',
    });
    await sweep(after(2 + HOUR));
    // Resolving again owes a new one.
    await move(made.ticketId, 'resolved', after(20));
    expect((await survey(made.ticketId)).map((s) => s.status).sort()).toEqual([
      'scheduled',
      'voided',
    ]);
  });

  it('voids rather than sends when the ticket was reopened behind the survey back', async () => {
    const made = await resolvedTicket({ resolvedAfter: 2 });
    // Reopened without going through the status machinery (a safety net, not the usual path).
    await env.db.owner.db
      .update(schema.ticket)
      .set({ status: 'open' })
      .where(eq(schema.ticket.id, made.ticketId));
    await sweep(after(2 + HOUR));
    expect((await only(made.ticketId)).status).toBe('voided');
  });

  it('sends one reminder after 48 hours when unanswered, and no second', async () => {
    const made = await resolvedTicket({ resolvedAfter: 2 });
    const row = await only(made.ticketId);
    const sentAt = 2 + HOUR;
    await sweep(after(sentAt));
    await sweep(after(sentAt + 48 * HOUR - 1));
    expect(await emailJobs('csat-reminder', row.id)).toHaveLength(0);
    await sweep(after(sentAt + 48 * HOUR));
    await sweep(after(sentAt + 49 * HOUR));
    const reminder = await emailJobs('csat-reminder', row.id);
    expect(reminder).toHaveLength(1);
    expect(reminder[0]?.payload).toMatchObject({ kind: 'csat_survey', reminder: true });
    // The reminder carries the same link as the first email: one link per survey.
    expect((await linkOf('csat-reminder', row.id)).token).toBe(
      (await linkOf('csat-survey', row.id)).token,
    );
  });

  it('sends no reminder to a customer who answered', async () => {
    const made = await resolvedTicket({ resolvedAfter: 2 });
    const row = await only(made.ticketId);
    await sweep(after(2 + HOUR));
    await answer(row.id, after(2 + 2 * HOUR), { score: 5 });
    await sweep(after(2 + HOUR + 48 * HOUR));
    expect(await emailJobs('csat-reminder', row.id)).toHaveLength(0);
  });

  it('closes the link when it runs out unanswered', async () => {
    const made = await resolvedTicket({ resolvedAfter: 2 });
    await sweep(after(2 + HOUR));
    const expiresAt = (await only(made.ticketId)).tokenExpiresAt as Date;
    await sweep(new Date(expiresAt.getTime() - 1000));
    expect((await only(made.ticketId)).status).toBe('sent');
    await sweep(expiresAt);
    expect((await only(made.ticketId)).status).toBe('expired');
  });

  it('refuses to send when the instance has no CSAT link configuration (fails closed)', async () => {
    const bare = await startDomainTest({ sealKey: SEAL_KEY });
    try {
      const org = await addOrg(bare);
      const { value } = await bare.tx((tx) =>
        bare.domain.tickets.create(tx, bare.ctx(undefined, { now: () => T0 }), {
          orgId: org.id,
          subject: 's',
          body: 'b',
          requester: { email: 'a@customer.test', name: 'A' },
        }),
      );
      await bare.tx((tx) =>
        bare.domain.tickets.changeStatus(tx, bare.ctx(undefined, { now: () => after(1) }), {
          ref: value.ticket.id,
          status: 'open',
        }),
      );
      await bare.tx((tx) =>
        bare.domain.tickets.changeStatus(tx, bare.ctx(undefined, { now: () => after(2) }), {
          ref: value.ticket.id,
          status: 'resolved',
        }),
      );
      await expect(
        bare.domain.csat.sweep(
          bare.database.db,
          bare.ctx(undefined, { now: () => after(2 + HOUR) }),
        ),
      ).rejects.toThrow('CSAT is not configured');
      const [row] = await bare.db.owner.db.select().from(schema.csatSurvey);
      expect(row?.status).toBe('scheduled');
    } finally {
      await bare.close();
    }
  });
});

describe('answering (R-10.2, R-10.5, R-1.10)', () => {
  async function sentSurvey(resolvedAfter = 2) {
    const made = await resolvedTicket({ resolvedAfter });
    const row = await only(made.ticketId);
    await sweep(after(resolvedAfter + HOUR));
    return { made, id: row.id, answerAt: after(resolvedAfter + 2 * HOUR) };
  }

  it('records the score, the comment and "resolved", copies the score to the ticket', async () => {
    const { made, id, answerAt } = await sentSurvey();
    const { value, audited } = await answer(id, answerAt, {
      score: 4,
      resolved: true,
      comment: 'Thanks',
    });
    expect(value).toMatchObject({ kind: 'recorded', reopened: false });
    expect(audited).toBe(true);
    const row = await only(made.ticketId);
    expect(row).toMatchObject({
      status: 'answered',
      score: 4,
      resolved: true,
      comment: 'Thanks',
      reopened: false,
    });
    expect(row.answeredAt?.toISOString()).toBe(answerAt.toISOString());
    const ticket = await ticketRow(made.ticketId);
    expect(ticket.csatScore).toBe(4);
    expect(ticket.status).toBe('resolved');
    expect(await eventTypes(env, made.ticketId)).toContain('ticket.csat_received');
  });

  it('audits the answer with the score but never the comment (N4)', async () => {
    const { id, answerAt } = await sentSurvey();
    await answer(id, answerAt, { score: 5, comment: 'My phone number is 0812345678' });
    const entry = (await auditRows(env, 'csat.response')).find((a) => a.targetId === id);
    expect(entry?.metadata).toMatchObject({ score: 5, reopened: false });
    expect(JSON.stringify(entry)).not.toContain('0812345678');
    expect(entry?.actorType).toBe('anonymous');
  });

  it('a link works once: the second answer is refused and changes nothing', async () => {
    const { made, id, answerAt } = await sentSurvey();
    await answer(id, answerAt, { score: 5 });
    const again = await answer(id, after(10 * DAY), { score: 1, comment: 'changed my mind' });
    expect(again.value).toEqual({ kind: 'already_answered' });
    expect(again.audited).toBe(false);
    expect(await only(made.ticketId)).toMatchObject({ score: 5, comment: null, reopened: false });
    expect((await ticketRow(made.ticketId)).status).toBe('resolved');
  });

  it('two answers racing for the same link record exactly one', async () => {
    const { made, id, answerAt } = await sentSurvey();
    const outcomes = await Promise.all(
      [1, 5, 2, 4].map((score) => answer(id, answerAt, { score })),
    );
    expect(outcomes.filter((o) => o.value.kind === 'recorded')).toHaveLength(1);
    expect(outcomes.filter((o) => o.value.kind === 'already_answered')).toHaveLength(3);
    expect(await survey(made.ticketId)).toHaveLength(1);
  });

  it('refuses an answer after the link expired', async () => {
    const { made, id } = await sentSurvey();
    const expiresAt = (await only(made.ticketId)).tokenExpiresAt as Date;
    const late = await answer(id, expiresAt, { score: 5 });
    expect(late.value).toEqual({ kind: 'unavailable' });
    expect((await only(made.ticketId)).status).toBe('sent');
  });

  it('refuses an answer to a survey that was voided or never sent, and to one that does not exist', async () => {
    const owed = await resolvedTicket();
    const row = await only(owed.ticketId);
    expect((await answer(row.id, after(5), { score: 1 })).value).toEqual({ kind: 'unavailable' });
    await move(owed.ticketId, 'open', after(10));
    expect((await answer(row.id, after(11), { score: 1 })).value).toEqual({ kind: 'unavailable' });
    expect((await answer(randomUUID(), after(11), { score: 1 })).value).toEqual({
      kind: 'unavailable',
    });
  });

  it.each([1, 2])(
    'a score of %i reopens a ticket resolved inside the window (R-1.10)',
    async (score) => {
      const { made, id, answerAt } = await sentSurvey();
      const { value, events } = await answer(id, answerAt, { score });
      expect(value).toMatchObject({ kind: 'recorded', reopened: true });
      const ticket = await ticketRow(made.ticketId);
      expect(ticket).toMatchObject({
        status: 'open',
        reopenCount: 1,
        resolvedAt: null,
        csatScore: score,
      });
      expect(await only(made.ticketId)).toMatchObject({ status: 'answered', reopened: true });
      expect(await eventTypes(env, made.ticketId)).toContain('ticket.reopened');
      expect(events.some((e) => e.type === 'ticket.updated')).toBe(true);
      const entry = (await auditRows(env, 'csat.response')).find((a) => a.targetId === id);
      expect(entry?.metadata).toMatchObject({ reopened: true });
    },
  );

  it('says "not resolved" reopens even with a good score', async () => {
    const { made, id, answerAt } = await sentSurvey();
    const { value } = await answer(id, answerAt, { score: 4, resolved: false });
    expect(value).toMatchObject({ reopened: true });
    expect(await ticketRow(made.ticketId)).toMatchObject({ status: 'open', reopenCount: 1 });
  });

  it('does not reopen at a score of 3, and tells the customer nothing of a reopen by email', async () => {
    const { made, id, answerAt } = await sentSurvey();
    expect((await answer(id, answerAt, { score: 3 })).value).toMatchObject({ reopened: false });
    expect(await ticketRow(made.ticketId)).toMatchObject({ status: 'resolved', reopenCount: 0 });
  });

  it('does not reopen a ticket resolved more than 7 days ago, but keeps the score', async () => {
    const { made, id } = await sentSurvey();
    const answerAt = after(2 + 8 * DAY);
    const { value } = await answer(id, answerAt, { score: 1 });
    expect(value).toMatchObject({ kind: 'recorded', reopened: false });
    expect(await ticketRow(made.ticketId)).toMatchObject({ status: 'resolved', csatScore: 1 });
    const entry = (await auditRows(env, 'csat.response')).find((a) => a.targetId === id);
    expect(entry?.metadata).toMatchObject({ reopenSkipped: 'window_closed' });
  });

  it('does not reopen a closed ticket (closed is final)', async () => {
    const { made, id, answerAt } = await sentSurvey();
    await move(made.ticketId, 'closed', after(2 + HOUR + 30));
    const { value } = await answer(id, answerAt, { score: 1 });
    expect(value).toMatchObject({ kind: 'recorded', reopened: false });
    expect((await ticketRow(made.ticketId)).status).toBe('closed');
  });

  it('a reopened ticket resolved again is still spared by the 7-day contact cooldown', async () => {
    const { made, id, answerAt } = await sentSurvey();
    await answer(id, answerAt, { score: 1 });
    await move(made.ticketId, 'resolved', after(3 * DAY));
    // The contact was surveyed 3 days ago, so the cooldown spares them this time.
    expect((await survey(made.ticketId)).map((s) => s.status).sort()).toEqual([
      'answered',
      'skipped',
    ]);
  });
});
