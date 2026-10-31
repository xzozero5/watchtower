import { randomUUID } from 'node:crypto';

import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { ChannelError } from '../common/errors.js';
import { FakeLineTransport } from './fake.js';
import { decideLineRoute } from './router.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const text = (value: string) => [{ type: 'text' as const, text: value }];

function clock(start = '2025-10-14T02:00:00Z') {
  let now = new Date(start).getTime();
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('FakeLineTransport: reply token', () => {
  it('expires after the configured lifetime and burns the token when used late', async () => {
    const time = clock();
    const fake = new FakeLineTransport({ now: time.now, replyTokenTtlMs: 60_000 });
    const early = fake.issueReplyToken();
    const late = fake.issueReplyToken();
    time.advance(30_000);
    await expect(fake.reply({ replyToken: early, messages: text('ok') })).resolves.toBeDefined();
    time.advance(31_000);
    await expect(
      fake.reply({ replyToken: late, messages: text('too late') }),
    ).rejects.toMatchObject({
      code: 'invalid_reply_token',
    });
    expect(fake.replies.map((r) => r.texts[0])).toEqual(['ok']);
  });

  it('is single use even for two concurrent attempts', async () => {
    const fake = new FakeLineTransport();
    const token = fake.issueReplyToken();
    const results = await Promise.allSettled([
      fake.reply({ replyToken: token, messages: text('a') }),
      fake.reply({ replyToken: token, messages: text('b') }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('does not count against the monthly quota', async () => {
    const fake = new FakeLineTransport({ monthlyLimit: 1 });
    await fake.reply({ replyToken: fake.issueReplyToken(), messages: text('a') });
    await fake.reply({ replyToken: fake.issueReplyToken(), messages: text('b') });
    expect(fake.totalUsage).toBe(0);
  });
});

describe('FakeLineTransport: push, retry key and quota', () => {
  it('fails with 429 monthly_limit once the limit is spent, and does not count the failure', async () => {
    const fake = new FakeLineTransport({ monthlyLimit: 2 });
    await fake.push({ to: 'U1', messages: text('1'), retryKey: randomUUID() });
    await fake.push({ to: 'U1', messages: text('2'), retryKey: randomUUID() });
    const error = await fake
      .push({ to: 'U1', messages: text('3'), retryKey: randomUUID() })
      .catch((c: unknown) => c);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error).toMatchObject({ kind: 'rate_limited', status: 429, code: 'monthly_limit' });
    expect(fake.totalUsage).toBe(2);
  });

  it('answers a repeated key with the first request id, even if the quota ran out meanwhile', async () => {
    const fake = new FakeLineTransport({ monthlyLimit: 1 });
    const retryKey = randomUUID();
    const first = await fake.push({ to: 'U1', messages: text('1'), retryKey });
    const again = await fake.push({ to: 'U1', messages: text('1'), retryKey });
    expect(again).toMatchObject({ alreadyAccepted: true, acceptedRequestId: first.requestId });
    expect(fake.pushes).toHaveLength(1);
  });

  it('forgets a retry key after 24 hours', async () => {
    const time = clock();
    const fake = new FakeLineTransport({ now: time.now });
    const retryKey = randomUUID();
    await fake.push({ to: 'U1', messages: text('1'), retryKey });
    time.advance(24 * 3600 * 1000 + 1);
    const again = await fake.push({ to: 'U1', messages: text('1'), retryKey });
    expect(again.alreadyAccepted).toBe(false);
    expect(fake.pushes).toHaveLength(2);
  });

  it('reports no target limit as type none, and counts messages sent from the Manager', async () => {
    const fake = new FakeLineTransport({ monthlyLimit: null });
    expect(await fake.getQuota()).toEqual({ type: 'none' });
    fake.addExternalConsumption(7);
    expect(await fake.getConsumption()).toEqual({ totalUsage: 7 });
  });

  it('can be told to fail the next call once (timeout simulation for dispatcher tests)', async () => {
    const fake = new FakeLineTransport();
    fake.failNext(
      'message.push',
      new ChannelError({ provider: 'line', operation: 'message.push', kind: 'timeout' }),
    );
    const retryKey = randomUUID();
    await expect(fake.push({ to: 'U1', messages: text('x'), retryKey })).rejects.toMatchObject({
      kind: 'timeout',
      outcomeUnknown: true,
    });
    // The retry with the same key now succeeds and is counted once: the ADR-010 retry story.
    await expect(fake.push({ to: 'U1', messages: text('x'), retryKey })).resolves.toMatchObject({
      alreadyAccepted: false,
    });
    expect(fake.totalUsage).toBe(1);
  });
});

describe('FakeLineTransport: content, read marks and loading animation', () => {
  it('serves stored content and reports 202 while a large file is being prepared', async () => {
    const fake = new FakeLineTransport();
    fake.setContent('m1', Uint8Array.from([1, 2, 3]), 'image/jpeg');
    fake.setContentPreparing('m2');
    expect(await fake.getContent('m1')).toEqual({
      status: 'ready',
      bytes: Uint8Array.from([1, 2, 3]),
      contentType: 'image/jpeg',
    });
    expect(await fake.getContent('m2')).toEqual({ status: 'preparing' });
    fake.setContent('m2', Uint8Array.from([9]));
    expect(await fake.getContent('m2')).toMatchObject({ status: 'ready' });
  });

  it('accepts a read token many times (it has no expiry) and records loading animations', async () => {
    const fake = new FakeLineTransport();
    const token = fake.issueMarkAsReadToken();
    await fake.markAsRead({ markAsReadToken: token });
    await fake.markAsRead({ markAsReadToken: token });
    expect(fake.readMarks).toHaveLength(2);
    await fake.showLoadingAnimation({ chatId: 'U1' });
    await fake.showLoadingAnimation({ chatId: 'U1', loadingSeconds: 60 });
    expect(fake.loadingAnimations.map((a) => a.loadingSeconds)).toEqual([20, 60]);
  });
});

describe('router + fake: end to end', () => {
  it('uses the reply token first, then falls back to push once the token is spent', async () => {
    const time = clock();
    const fake = new FakeLineTransport({ now: time.now });
    const token = fake.issueReplyToken();
    const received = time.now();

    const first = decideLineRoute({
      now: time.now(),
      replyToken: { receivedAt: received, used: false },
      quota: { used: 0, limit: 300 },
      pushFallback: 'allow',
    });
    expect(first.route).toBe('reply');
    await fake.reply({ replyToken: token, messages: text('ack') });

    const second = decideLineRoute({
      now: time.now(),
      replyToken: { receivedAt: received, used: true },
      quota: { used: 0, limit: 300 },
      pushFallback: 'allow',
    });
    expect(second).toMatchObject({ route: 'push', reason: 'reply_token_used' });
    await fake.push({ to: 'U1', messages: text('human reply'), retryKey: randomUUID() });
    expect(fake.totalUsage).toBe(1);
  });
});
