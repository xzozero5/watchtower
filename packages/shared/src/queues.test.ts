import { describe, expect, it } from 'vitest';

import {
  EMAIL_OUTBOX_JOB_OPTIONS,
  EMAIL_SECRET_FIELDS,
  emailJobSchema,
  splitEmailSecrets,
  outboxJobOptionsSchema,
  sealedEnvelopeSchema,
} from './queues.js';

describe('outboxJobOptionsSchema', () => {
  it('accepts the options of the email job', () => {
    expect(outboxJobOptionsSchema.parse(EMAIL_OUTBOX_JOB_OPTIONS)).toEqual(
      EMAIL_OUTBOX_JOB_OPTIONS,
    );
    expect(outboxJobOptionsSchema.parse({})).toEqual({});
  });

  it('refuses an option nobody reviewed, and values out of range', () => {
    expect(outboxJobOptionsSchema.safeParse({ repeat: { every: 1 } }).success).toBe(false);
    expect(outboxJobOptionsSchema.safeParse({ jobId: 'other' }).success).toBe(false);
    expect(outboxJobOptionsSchema.safeParse({ attempts: 0 }).success).toBe(false);
    expect(outboxJobOptionsSchema.safeParse({ attempts: 1000 }).success).toBe(false);
    expect(
      outboxJobOptionsSchema.safeParse({ backoff: { type: 'linear', delay: 5 } }).success,
    ).toBe(false);
    expect(outboxJobOptionsSchema.safeParse({ removeOnFail: { count: 5 } }).success).toBe(false);
  });
});

describe('email jobs and their secret fields', () => {
  const tracking = 'http://localhost:3000/portal/tickets/OPS-1#token=wtp1.abc';
  const base = {
    to: 'a@example.com',
    locale: 'en' as const,
    ticketKey: 'OPS-1',
    trackingUrl: tracking,
  };

  it('names exactly the fields that carry a bearer token', () => {
    const magic = emailJobSchema.parse({
      kind: 'magic_link',
      to: 'a@example.com',
      link: 'http://localhost:3000/login/magic#token=x',
      expiresInMinutes: 15,
    });
    expect(Object.keys(magic).filter((key) => EMAIL_SECRET_FIELDS.includes(key as never))).toEqual([
      'link',
    ]);
    const portal = emailJobSchema.parse({
      kind: 'portal_link',
      ...base,
    });
    expect(Object.keys(portal).filter((key) => EMAIL_SECRET_FIELDS.includes(key as never))).toEqual(
      ['trackingUrl'],
    );
  });

  it('seals the link of the "my requests" email and keeps it free of any ticket (T-152)', () => {
    const { clear, secret } = splitEmailSecrets({
      kind: 'portal_my_requests',
      to: 'a@example.com',
      locale: 'th',
      trackingUrl: tracking,
      expiresInMinutes: 30,
    });
    expect(secret).toEqual({ trackingUrl: tracking });
    expect(clear).toEqual({
      kind: 'portal_my_requests',
      to: 'a@example.com',
      locale: 'th',
      expiresInMinutes: 30,
    });
  });

  it('splits a job into clear fields and the sealed ones', () => {
    const { clear, secret } = splitEmailSecrets({
      kind: 'portal_link',
      ...base,
    });
    expect(secret).toEqual({ trackingUrl: tracking });
    expect(clear).toEqual({
      kind: 'portal_link',
      to: 'a@example.com',
      locale: 'en',
      ticketKey: 'OPS-1',
    });
    expect(JSON.stringify(clear)).not.toContain('token');
  });

  it('does not carry the submitter-typed subject in the confirmation or the new-link email (C-11)', () => {
    const confirmation = emailJobSchema.parse({
      kind: 'portal_confirmation',
      ...base,
      subject: 'Click here to claim a prize',
      expectedFirstResponseAt: null,
    });
    expect('subject' in confirmation).toBe(false);
    const link = emailJobSchema.parse({ kind: 'portal_link', ...base, subject: 'anything' });
    expect('subject' in link).toBe(false);
    // The emails that follow a staff action still name the ticket.
    const update = emailJobSchema.parse({
      kind: 'portal_update',
      ...base,
      subject: 'Webhook fails',
      reason: 'staff_reply',
      status: 'in_progress',
      agentName: 'Somchai',
    });
    expect('subject' in update && update.subject).toBe('Webhook fails');
  });
});

describe('sealedEnvelopeSchema', () => {
  it('needs the sealed part and keeps the public fields', () => {
    expect(sealedEnvelopeSchema.safeParse({ kind: 'magic_link' }).success).toBe(false);
    const parsed = sealedEnvelopeSchema.parse({
      kind: 'magic_link',
      to: 'a@example.com',
      secret: 'v1.a.b.c',
      notAfter: 1_800_000_000_000,
    });
    expect(parsed).toMatchObject({ kind: 'magic_link', notAfter: 1_800_000_000_000 });
    expect(sealedEnvelopeSchema.safeParse({ secret: 'x', notAfter: -1 }).success).toBe(false);
  });
});
