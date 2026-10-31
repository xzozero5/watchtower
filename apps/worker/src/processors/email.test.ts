import { QUEUE_NAMES } from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it } from 'vitest';

import type { Mailer, OutboundMessage } from '../mailer.js';
import { sealedEmailPayload } from '../testing/support.js';
import { createEmailProcessor, renderEmail } from './email.js';

const magicLink = {
  kind: 'magic_link' as const,
  to: 'client@example.com',
  link: 'http://localhost:3000/login/magic#token=abc_DEF-123&x="y"',
  expiresInMinutes: 15,
};

function fakeMailer(): Mailer & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
      return Promise.resolve();
    },
    close() {
      // nothing to close
    },
  };
}

const sealKey = deriveSubkey(
  'a-root-key-of-more-than-thirty-two-characters',
  KEY_LABELS.outboxSecret,
);

/** A BullMQ job as the worker sees it after the relay: sealed payload, id and queue. */
const jobWith = (data: unknown, id = 'job-1'): Job =>
  ({ data, id, queueName: QUEUE_NAMES.email }) as unknown as Job;
const sealedJob = (job: Parameters<typeof sealedEmailPayload>[0], id = 'job-1', extra = {}): Job =>
  jobWith({ ...sealedEmailPayload(job, id, sealKey), ...extra }, id);
const processorFor = (mailer: Mailer, now?: () => number) =>
  createEmailProcessor(mailer, { sealKey, ...(now === undefined ? {} : { now }) });

describe('renderEmail', () => {
  it('puts the link and the lifetime in both parts, in English and Thai', () => {
    const message = renderEmail(magicLink);
    expect(message.to).toBe('client@example.com');
    expect(message.subject).toContain('sign-in');
    expect(message.text).toContain(magicLink.link);
    expect(message.text).toContain('15 minutes');
    expect(message.text).toContain('15 นาที');
    expect(message.html).toContain('15 minutes');
  });

  it('escapes the link in HTML so it cannot break out of the attribute', () => {
    const { html } = renderEmail(magicLink);
    expect(html).toContain('&quot;y&quot;');
    expect(html).toContain('&amp;x=');
    expect(html).not.toContain('"y"');
  });
});

describe('email processor', () => {
  it('opens the sealed link and sends the job once', async () => {
    const mailer = fakeMailer();
    await expect(processorFor(mailer)(sealedJob(magicLink))).resolves.toEqual({ sent: true });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.text).toContain(magicLink.link);
  });

  it('keeps the link out of the job data the queue holds', () => {
    const job = sealedJob(magicLink);
    const data = JSON.stringify(job.data);
    expect(data).not.toContain('abc_DEF');
    expect(data).not.toContain('localhost');
    expect(job.data).toMatchObject({ kind: 'magic_link', to: 'client@example.com' });
  });

  it('drops a job past its notAfter without sending, and completes it', async () => {
    const mailer = fakeMailer();
    const process = processorFor(mailer, () => 2_000);
    await expect(process(sealedJob(magicLink, 'job-1', { notAfter: 1_999 }))).resolves.toEqual({
      sent: false,
      dropped: 'expired',
    });
    await expect(process(sealedJob(magicLink, 'job-1', { notAfter: 2_000 }))).resolves.toEqual({
      sent: false,
      dropped: 'expired',
    });
    expect(mailer.sent).toHaveLength(0);
    await expect(process(sealedJob(magicLink, 'job-1', { notAfter: 2_001 }))).resolves.toEqual({
      sent: true,
    });
    expect(mailer.sent).toHaveLength(1);
  });

  it('ends an invalid payload at once, without retries and without sending', async () => {
    const mailer = fakeMailer();
    const process = processorFor(mailer);
    await expect(process(jobWith({ kind: 'magic_link', to: 'x' }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(process(jobWith({ kind: 'unknown' }))).rejects.toBeInstanceOf(UnrecoverableError);
    // A job that still carries the link in the clear (the pre-0005 format) is refused, not sent.
    await expect(process(jobWith(magicLink))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mailer.sent).toHaveLength(0);
  });

  it('refuses a sealed part that was tampered with, moved to another job, or sealed under another key', async () => {
    const mailer = fakeMailer();
    const process = processorFor(mailer);
    const sealed = sealedEmailPayload(magicLink, 'job-1', sealKey);
    await expect(process(jobWith(sealed, 'job-2'))).rejects.toThrow('cannot be opened');
    await expect(
      process(jobWith({ ...sealed, secret: `${String(sealed.secret).slice(0, -3)}AAA` }, 'job-1')),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    const otherKey = deriveSubkey(
      'another-root-key-of-more-than-32-characters!',
      KEY_LABELS.outboxSecret,
    );
    await expect(
      process(jobWith(sealedEmailPayload(magicLink, 'job-1', otherKey), 'job-1')),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mailer.sent).toHaveLength(0);
  });

  it('never puts the link in an error message', async () => {
    const mailer = fakeMailer();
    const failures: string[] = [];
    for (const job of [
      jobWith({ ...sealedEmailPayload(magicLink, 'job-1', sealKey) }, 'wrong-id'),
      jobWith(magicLink),
    ]) {
      try {
        await processorFor(mailer)(job);
      } catch (error) {
        failures.push(String(error));
      }
    }
    expect(failures).toHaveLength(2);
    for (const failure of failures) expect(failure).not.toContain('abc_DEF');
  });

  it('lets an SMTP failure through as a normal error, so BullMQ retries it', async () => {
    const failing: Mailer = {
      send: () => Promise.reject(new Error('connection refused')),
      close() {
        // nothing to close
      },
    };
    const rejection = processorFor(failing)(sealedJob(magicLink));
    await expect(rejection).rejects.toThrow('connection refused');
    await expect(rejection).rejects.not.toBeInstanceOf(UnrecoverableError);
  });
});

describe('portal emails (T-007)', () => {
  const base = {
    to: 'customer@example.com',
    ticketKey: 'OPS-12',
    subject: 'Webhook <b>never</b> arrives',
    trackingUrl: 'http://localhost:3000/portal/tickets/OPS-12#token=wtp1.abc_DEF-1&x="y"',
  };
  const confirmation = {
    kind: 'portal_confirmation' as const,
    ...base,
    locale: 'en' as const,
    expectedFirstResponseAt: '2026-11-03T08:30:00.000Z',
  };

  it('confirms in English with the ticket number, the SLA target and the tracking link', () => {
    const message = renderEmail(confirmation);
    expect(message.to).toBe('customer@example.com');
    expect(message.subject).toBe('We received your request OPS-12');
    expect(message.text).toContain(base.trackingUrl);
    expect(message.text).toContain('3 Nov 2026');
    expect(message.text).toContain('UTC');
    expect(message.text).not.toMatch(/[\u0E00-\u0E7F]/);
  });

  it('confirms in Thai when the contact prefers it', () => {
    const message = renderEmail({ ...confirmation, locale: 'th' });
    expect(message.subject).toBe('เราได้รับคำขอ OPS-12 แล้ว');
    expect(message.text).toContain('OPS-12');
    expect(message.text).toContain(base.trackingUrl);
  });

  it('does not repeat what the submitter typed, in either language (C-11)', () => {
    const typed = { ...confirmation, subject: 'Click https://evil.example to claim a prize' };
    for (const locale of ['en', 'th'] as const) {
      for (const job of [
        { ...typed, locale },
        { kind: 'portal_link' as const, ...base, locale, subject: typed.subject },
      ]) {
        const message = renderEmail(job);
        expect(message.text, `${job.kind} ${locale}`).not.toContain('evil.example');
        expect(message.html).not.toContain('evil.example');
        expect(message.subject).not.toContain('evil.example');
      }
    }
  });

  it('escapes the staff-facing subject and the link in HTML, and has no images or remote resources', () => {
    const { html } = renderEmail(confirmation);
    expect(html).toContain('&quot;y&quot;');
    const update = renderEmail({
      kind: 'portal_update',
      ...base,
      locale: 'en',
      reason: 'staff_reply',
      status: 'in_progress',
      agentName: 'Somchai',
    });
    expect(update.html).toContain('&lt;b&gt;never&lt;/b&gt;');
    expect(update.html).not.toContain('<b>never');
    expect(html).not.toMatch(/<img|<script|<link|<iframe|url\(/i);
    expect(html.match(/href="/g)).toHaveLength(1);
  });

  it('says who replied, by first name only, and the status', () => {
    const message = renderEmail({
      kind: 'portal_update',
      ...base,
      locale: 'en',
      reason: 'staff_reply',
      status: 'in_progress',
      agentName: 'Somchai',
    });
    expect(message.subject).toBe('New reply on OPS-12');
    expect(message.text).toContain('Somchai from our support team');
    expect(message.text).toContain('In progress');
  });

  it('reports a status change in the customer words and asks for a reply when it waits on them', () => {
    const waiting = renderEmail({
      kind: 'portal_update',
      ...base,
      locale: 'en',
      reason: 'status_change',
      status: 'waiting_for_you',
      agentName: null,
    });
    expect(waiting.subject).toBe('OPS-12 is now: Waiting for your reply');
    expect(waiting.text).toContain('We need your reply');
    const resolved = renderEmail({
      kind: 'portal_update',
      ...base,
      locale: 'th',
      reason: 'status_change',
      status: 'resolved',
      agentName: null,
    });
    expect(resolved.subject).toContain('แก้ไขแล้ว');
  });

  it('names the primary ticket in the merge notice (R-1.5)', () => {
    const english = renderEmail({ kind: 'portal_merged', ...base, locale: 'en', intoKey: 'OPS-3' });
    expect(english.subject).toBe('OPS-12 was merged into OPS-3');
    expect(english.text).toContain('OPS-3');
    const thai = renderEmail({ kind: 'portal_merged', ...base, locale: 'th', intoKey: 'OPS-3' });
    expect(thai.subject).toBe('OPS-12 ถูกรวมเข้ากับ OPS-3');
  });

  it('sends a new-link email', () => {
    const message = renderEmail({ kind: 'portal_link', ...base, locale: 'en' });
    expect(message.subject).toBe('Your link for OPS-12');
    expect(message.text).toContain('you can ignore it');
  });

  it('processes a portal job and ends an invalid one at once', async () => {
    const mailer = fakeMailer();
    const process = processorFor(mailer);
    await expect(process(sealedJob(confirmation))).resolves.toEqual({ sent: true });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.text).toContain(base.trackingUrl);
    await expect(
      process(jobWith({ ...sealedEmailPayload(confirmation, 'job-1', sealKey), locale: 'fr' })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
