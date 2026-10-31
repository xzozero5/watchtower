import { createRedactor } from '@watchtower/ai';
import type { NormalisedInboundMessage } from '@watchtower/domain';
import type { InboundClassification } from '@watchtower/shared';
import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { classifyMessage, type InboundClassifierHook, type RedactedText } from './classifier.js';

const logger = createLogger(testConfig());

const message = (overrides: Partial<NormalisedInboundMessage> = {}): NormalisedInboundMessage => ({
  channelAccountId: 'account',
  providerMessageId: 'm1',
  rfc822MessageId: null,
  threadKey: null,
  threadCandidates: [],
  from: { address: 'a@customer.example.test', name: null, lineUserId: null },
  subject: 'โทร 081-234-5678 ด่วน',
  bodyText: 'บัตรประชาชน 1-2345-67890-12-1 ใช้ไม่ได้',
  bodyHtml: null,
  attachments: [],
  receivedAt: new Date('2026-11-02T03:00:00Z'),
  rawObjectKey: null,
  automated: { disposition: 'human', subtype: 'none', signals: [] },
  ...overrides,
});

// A stand-in for the T-106c redactor: masks digits. The point is where the output goes.
const redactor = createRedactor();
const redact = (text: string): RedactedText =>
  redactor.session({ scope: 'classifier-test' }).redact(text);

const answer: InboundClassification = {
  type: 'new_customer_issue',
  intentKey: 'login_failure',
  confidence: 0.91,
  source: 'rules',
  aiRunId: null,
};

const hook = (classify: InboundClassifierHook['classify']): InboundClassifierHook => ({
  redact,
  classify,
});

describe('classifyMessage', () => {
  it('returns nothing without a hook, leaving the domain to apply the rules', async () => {
    expect(
      await classifyMessage(message(), 'gmail', { hook: undefined, timeoutMs: 100, logger }),
    ).toBe(undefined);
  });

  it('gives the hook only redacted text and marks its answer as coming from the AI', async () => {
    const classify = vi.fn<InboundClassifierHook['classify']>(() => Promise.resolve(answer));
    const result = await classifyMessage(message(), 'gmail', {
      hook: hook(classify),
      timeoutMs: 1000,
      logger,
    });
    expect(result).toMatchObject({ type: 'new_customer_issue', source: 'ai', confidence: 0.91 });
    const input = classify.mock.calls[0]?.[0];
    // The real redactor (T-106) replaces PII with typed tokens; no raw number reaches the hook.
    expect(input?.subject).toBe('โทร [PHONE_1] ด่วน');
    expect(input?.body).toBe('บัตรประชาชน [THAI_ID_1] ใช้ไม่ได้');
    expect(JSON.stringify(input)).not.toMatch(/081|2345|67890/);
  });

  it('falls back to the header rules when the hook is too slow, and tells the hook to stop', async () => {
    let aborted = false;
    const slow = hook(
      (_input, signal) =>
        new Promise<InboundClassification>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    );
    const started = Date.now();
    const result = await classifyMessage(message(), 'gmail', { hook: slow, timeoutMs: 50, logger });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ type: 'triage', source: 'rules' });
    expect(aborted).toBe(true);
  });

  it('falls back when the hook throws or answers something that is not a classification', async () => {
    const broken = await classifyMessage(
      message({ automated: { disposition: 'noise', subtype: 'mailing_list', signals: [] } }),
      'gmail',
      { hook: hook(() => Promise.reject(new Error('provider down'))), timeoutMs: 100, logger },
    );
    expect(broken).toMatchObject({ type: 'noise', source: 'rules' });
    const garbage = await classifyMessage(message(), 'gmail', {
      hook: hook(() => Promise.resolve({ type: 'nonsense' } as unknown as InboundClassification)),
      timeoutMs: 100,
      logger,
    });
    expect(garbage).toMatchObject({ type: 'triage', source: 'rules' });
  });

  it('does not call the hook for a mail the headers already call an automatic reply', async () => {
    const classify = vi.fn<InboundClassifierHook['classify']>(() => Promise.resolve(answer));
    const result = await classifyMessage(
      message({ automated: { disposition: 'auto_reply', subtype: 'bounce', signals: [] } }),
      'gmail',
      { hook: hook(classify), timeoutMs: 100, logger },
    );
    expect(classify).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: 'noise', source: 'rules' });
  });
});
