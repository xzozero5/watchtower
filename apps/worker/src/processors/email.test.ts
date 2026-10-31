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
