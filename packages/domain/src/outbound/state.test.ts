import { createHash } from 'node:crypto';

import {
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_AFTER_CAP_SECONDS,
  DELIVERY_STATES,
  type DeliveryRoute,
} from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { SAFE_AUTO_ACK_TEMPLATES } from '../autonomy/safe-templates.js';
import {
  backoffSeconds,
  canTransition,
  contentHash,
  decideFailure,
  dispatchJobId,
  hasIdempotencyKey,
  retryAfterSeconds,
} from './state.js';
import {
  RENDERABLE_TEMPLATE_KEYS,
  renderSystemTemplate,
  safeKeysWithoutRenderer,
} from './templates.js';
import { toDeliverySummary } from './summary.js';
import type { OutboundDeliveryRow } from '../rows.js';

describe('the state machine', () => {
  it('allows exactly the transitions of ADR-010', () => {
    const allowed = new Set([
      'scheduled>sending',
      'scheduled>cancelled',
      'sending>sent',
      'sending>failed',
      'sending>scheduled',
      'sending>cancelled',
      // only for an unknown outcome that the provider confirms late
      'failed>sent',
    ]);
    for (const from of DELIVERY_STATES) {
      for (const to of DELIVERY_STATES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it('never leaves cancelled or sent, and never goes back to scheduled from anywhere but sending', () => {
    for (const to of DELIVERY_STATES) {
      expect(canTransition('cancelled', to)).toBe(false);
      expect(canTransition('sent', to)).toBe(false);
    }
    expect(canTransition('failed', 'scheduled')).toBe(false);
    expect(canTransition('cancelled', 'scheduled')).toBe(false);
  });
});

describe('backoff', () => {
  it('doubles from 1 s and stops at 5 minutes', () => {
    expect([0, 1, 2, 3, 4, 5].map(backoffSeconds)).toEqual([1, 2, 4, 8, 16, 32]);
    expect(backoffSeconds(8)).toBe(256);
    expect(backoffSeconds(9)).toBe(300);
    expect(backoffSeconds(40)).toBe(300);
  });
});

describe('retry or give up', () => {
  const routes: (DeliveryRoute | null)[] = [
    null,
    'gmail_thread',
    'gmail_new',
    'line_reply',
    'line_push',
  ];
  const unknown = { kind: 'timeout', retryable: true, outcomeUnknown: true } as const;

  it('never repeats an unknown outcome unless the route has an idempotency key', () => {
    for (const route of routes) {
      const decision = decideFailure(unknown, { route, attempts: 1 });
      if (route === 'line_push') {
        expect(decision.action).toBe('retry');
      } else {
        expect(decision, String(route)).toEqual({
          action: 'fail',
          errorCode: 'channel_timeout',
          outcomeUnknown: true,
        });
      }
    }
    expect(hasIdempotencyKey('line_push')).toBe(true);
    expect(hasIdempotencyKey('line_reply')).toBe(false);
    expect(hasIdempotencyKey('gmail_thread')).toBe(false);
  });

  it('retries a certain non-delivery (429) with the longer of backoff and Retry-After', () => {
    const limited = { kind: 'rate_limited', retryable: true, outcomeUnknown: false } as const;
    expect(decideFailure(limited, { route: 'gmail_thread', attempts: 1 })).toEqual({
      action: 'retry',
      delaySeconds: 2,
      errorCode: 'channel_rate_limited',
    });
    expect(
      decideFailure({ ...limited, retryAfterMs: 90_000 }, { route: 'gmail_thread', attempts: 1 }),
    ).toEqual({ action: 'retry', delaySeconds: 90, errorCode: 'channel_rate_limited' });
  });

  it('a clean refusal after an earlier push stays unknown; with no earlier push it is a certain failure (T-125a)', () => {
    const refused = { kind: 'auth', retryable: false, outcomeUnknown: false } as const;
    expect(decideFailure(refused, { route: 'line_push', attempts: 2 })).toMatchObject({
      action: 'fail',
      outcomeUnknown: false,
    });
    expect(
      decideFailure(refused, { route: 'line_push', attempts: 2, earlierPush: true }),
    ).toMatchObject({ action: 'fail', outcomeUnknown: true });
    // A temporary error is still retried, earlier push or not; the last attempt gives up as unknown.
    const limited = { kind: 'rate_limited', retryable: true, outcomeUnknown: false } as const;
    expect(
      decideFailure(limited, { route: 'line_push', attempts: 2, earlierPush: true }).action,
    ).toBe('retry');
    expect(
      decideFailure(limited, { route: 'line_push', attempts: 99, earlierPush: true }),
    ).toMatchObject({ action: 'fail', outcomeUnknown: true });
  });

  it('never waits longer than the ceiling for a Retry-After, whatever the provider sends (T-122f)', () => {
    const limited = { kind: 'rate_limited', retryable: true, outcomeUnknown: false } as const;
    const wait = (retryAfterMs: number): number => {
      const decision = decideFailure(
        { ...limited, retryAfterMs },
        { route: 'gmail_thread', attempts: 1 },
      );
      if (decision.action !== 'retry') throw new Error('expected a retry');
      return decision.delaySeconds;
    };
    expect(wait(24 * 3600 * 1000)).toBe(DELIVERY_RETRY_AFTER_CAP_SECONDS);
    // A header too long for a number reaches us as Infinity; a damaged one as NaN or a negative.
    expect(wait(Number.POSITIVE_INFINITY)).toBe(DELIVERY_RETRY_AFTER_CAP_SECONDS);
    expect(wait(Number.NaN)).toBe(2);
    expect(wait(-5000)).toBe(2);
    expect(wait(DELIVERY_RETRY_AFTER_CAP_SECONDS * 1000)).toBe(DELIVERY_RETRY_AFTER_CAP_SECONDS);
    expect(retryAfterSeconds(1500)).toBe(2);
  });

  it('gives up after five attempts, even for a push', () => {
    const limited = { kind: 'rate_limited', retryable: true, outcomeUnknown: false } as const;
    expect(
      decideFailure(limited, { route: 'line_push', attempts: DELIVERY_MAX_ATTEMPTS - 1 }).action,
    ).toBe('retry');
    expect(decideFailure(limited, { route: 'line_push', attempts: DELIVERY_MAX_ATTEMPTS })).toEqual(
      {
        action: 'fail',
        errorCode: 'channel_rate_limited',
        outcomeUnknown: false,
      },
    );
    expect(decideFailure(unknown, { route: 'line_push', attempts: DELIVERY_MAX_ATTEMPTS })).toEqual(
      {
        action: 'fail',
        errorCode: 'channel_timeout',
        outcomeUnknown: true,
      },
    );
  });

  it('fails a 4xx and an auth problem at once, as not sent', () => {
    for (const kind of ['client', 'auth', 'not_found', 'unsupported']) {
      expect(
        decideFailure(
          { kind, retryable: false, outcomeUnknown: false },
          { route: 'gmail_new', attempts: 1 },
        ),
      ).toEqual({ action: 'fail', errorCode: `channel_${kind}`, outcomeUnknown: false });
    }
  });
});

describe('hashes and job ids', () => {
  it('hashes the exact UTF-8 text, hex', () => {
    expect(contentHash('สวัสดี')).toBe(createHash('sha256').update('สวัสดี', 'utf8').digest('hex'));
    expect(contentHash('a')).not.toBe(contentHash('a '));
    expect(contentHash('a')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('builds job ids without a colon, which BullMQ forbids', () => {
    const id = dispatchJobId('11111111-1111-4111-8111-111111111111', 3);
    expect(id).toBe('delivery-11111111-1111-4111-8111-111111111111-3');
    expect(id).not.toContain(':');
  });
});

describe('automatic acknowledgment templates (A-3)', () => {
  const vars = {
    ticketKey: 'OPS-12',
    portalUrl: 'https://desk.example.test/portal',
    firstResponseDueAt: new Date('2030-01-07T12:30:00.000Z'),
  };

  it('has a renderer for every key of the gate allow-list and no renderer outside it', () => {
    expect(safeKeysWithoutRenderer()).toEqual([]);
    for (const key of RENDERABLE_TEMPLATE_KEYS) {
      expect(SAFE_AUTO_ACK_TEMPLATES.has(key), key).toBe(true);
    }
  });

  it('renders only the ticket key, the portal link and the target', () => {
    const text = renderSystemTemplate('auto_ack.received_with_sla', vars) ?? '';
    expect(text).toContain('OPS-12');
    expect(text).toContain('https://desk.example.test/portal');
    expect(text).toContain('2030-01-07 19:30 (UTC+7)');
    // Fixed text: nothing a caller or a model could have written.
    expect(text.replaceAll('OPS-12', '').replaceAll(vars.portalUrl, '')).not.toMatch(
      /\{|\}|undefined|null/,
    );
  });

  it('leaves the link out without a portal address, and the target out without a due date', () => {
    const plain =
      renderSystemTemplate('auto_ack.received_with_sla', {
        ...vars,
        portalUrl: null,
        firstResponseDueAt: null,
      }) ?? '';
    expect(plain).not.toContain('http');
    expect(plain).not.toContain('UTC+7');
    expect(plain).toBe(renderSystemTemplate('auto_ack.received', { ...vars, portalUrl: null }));
  });

  it('does not render a key that is not a template, however it is spelled', () => {
    for (const key of [
      '',
      'auto_ack',
      'toString',
      '__proto__',
      'constructor',
      'AUTO_ACK.RECEIVED',
    ]) {
      expect(renderSystemTemplate(key, vars), key).toBeNull();
    }
  });
});

describe('the delivery summary for staff', () => {
  const row = (overrides: Partial<OutboundDeliveryRow>): OutboundDeliveryRow =>
    ({
      id: '11111111-1111-4111-8111-111111111111',
      state: 'scheduled',
      origin: 'human',
      channel: 'gmail',
      nextAttemptAt: new Date('2030-01-07T10:00:05.000Z'),
      attempts: 0,
      errorCode: null,
      outcomeUnknown: false,
      sentAt: null,
      ...overrides,
    }) as OutboundDeliveryRow;

  it('is cancellable only while scheduled and before the time', () => {
    const now = new Date('2030-01-07T10:00:00.000Z');
    expect(toDeliverySummary(row({}), now).cancellable).toBe(true);
    expect(toDeliverySummary(row({}), new Date('2030-01-07T10:00:05.000Z')).cancellable).toBe(
      false,
    );
    expect(toDeliverySummary(row({ state: 'sending' }), now).cancellable).toBe(false);
    expect(toDeliverySummary(row({ state: 'cancelled' }), now).cancellable).toBe(false);
  });

  it('is not cancellable with no hold, nor once a push was attempted (T-122f)', () => {
    const now = new Date('2030-01-07T10:00:00.000Z');
    expect(toDeliverySummary(row({ holdSeconds: 0 }), now).cancellable).toBe(false);
    expect(toDeliverySummary(row({ holdSeconds: 5 }), now).cancellable).toBe(true);
    const retriedPush = row({ route: 'line_push', attempts: 1, holdSeconds: 5 });
    expect(toDeliverySummary(retriedPush, now).cancellable).toBe(false);
    const retriedGmail = row({ route: 'gmail_thread', attempts: 1, holdSeconds: 5 });
    expect(toDeliverySummary(retriedGmail, now).cancellable).toBe(true);
  });

  it('carries no provider id, no hash and no text', () => {
    const summary = toDeliverySummary(
      row({ state: 'failed', errorCode: 'channel_auth' }),
      new Date(),
    );
    expect(Object.keys(summary).sort()).toEqual([
      'attempts',
      'cancellable',
      'channel',
      'errorCode',
      'id',
      'origin',
      'outcomeUnknown',
      'sendAt',
      'sentAt',
      'state',
    ]);
  });
});
