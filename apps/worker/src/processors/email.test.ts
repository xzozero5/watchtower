import { UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it } from 'vitest';

import type { Mailer, OutboundMessage } from '../mailer.js';
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

const jobWith = (data: unknown): Job => ({ data }) as unknown as Job;

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
  it('sends a valid job once', async () => {
    const mailer = fakeMailer();
    await expect(createEmailProcessor(mailer)(jobWith(magicLink))).resolves.toEqual({ sent: true });
    expect(mailer.sent).toHaveLength(1);
  });

  it('ends an invalid payload at once, without retries and without sending', async () => {
    const mailer = fakeMailer();
    const process = createEmailProcessor(mailer);
    await expect(process(jobWith({ kind: 'magic_link', to: 'x' }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(process(jobWith({ kind: 'unknown' }))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mailer.sent).toHaveLength(0);
  });

  it('lets an SMTP failure through as a normal error, so BullMQ retries it', async () => {
    const failing: Mailer = {
      send: () => Promise.reject(new Error('connection refused')),
      close() {
        // nothing to close
      },
    };
    const rejection = createEmailProcessor(failing)(jobWith(magicLink));
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

  it('escapes the subject and the link in HTML, and has no images or remote resources', () => {
    const { html } = renderEmail(confirmation);
    expect(html).toContain('&lt;b&gt;never&lt;/b&gt;');
    expect(html).not.toContain('<b>never');
    expect(html).toContain('&quot;y&quot;');
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
    const process = createEmailProcessor(mailer);
    await expect(process(jobWith(confirmation))).resolves.toEqual({ sent: true });
    expect(mailer.sent).toHaveLength(1);
    await expect(process(jobWith({ ...confirmation, locale: 'fr' }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });
});
