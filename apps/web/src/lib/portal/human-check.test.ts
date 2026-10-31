import type { HumanChallenge } from '@watchtower/shared';
import { describe, expect, it, vi } from 'vitest';

import { HumanCheck, type CheckState } from './human-check';
import { PowAbortedError } from './pow-core';
import { PortalApiError } from './portal-client';
import { submitRequest } from './submit-flow';
import type { SubmitPayload } from './form-model';
import type { SolveHandle } from './solve';

const CHALLENGE: HumanChallenge = {
  provider: 'pow-sha256',
  challenge: 'id.100.40.8.sig',
  difficultyBits: 8,
  issuedAt: '2026-11-05T10:00:00.000Z',
  expiresAt: '2026-11-05T10:30:00.000Z',
  minFillSeconds: 3,
};

function setup(
  overrides: { challenge?: () => Promise<HumanChallenge>; solve?: () => SolveHandle } = {},
) {
  const clock = { now: 1_000_000 };
  const states: CheckState[] = [];
  const sleeps: number[] = [];
  const api = { challenge: vi.fn(overrides.challenge ?? (() => Promise.resolve(CHALLENGE))) };
  const solve = vi.fn(
    overrides.solve ??
      ((): SolveHandle => ({
        promise: Promise.resolve({ nonce: '42', attempts: 43 }),
        cancel: vi.fn(),
      })),
  );
  const check = new HumanCheck({
    api,
    solve,
    now: () => clock.now,
    sleep: (ms) => {
      sleeps.push(ms);
      clock.now += ms;
      return Promise.resolve();
    },
    onChange: (state) => states.push(state),
  });
  return { check, api, solve, clock, states, sleeps };
}

describe('HumanCheck', () => {
  it('asks for a challenge when it starts, solves it and reports each phase', async () => {
    const { check, api, solve, states } = setup();
    check.start();
    check.start(); // a second start does not ask again
    await vi.waitFor(() => {
      expect(states.at(-1)).toEqual({ phase: 'ready' });
    });
    expect(api.challenge).toHaveBeenCalledTimes(1);
    expect(solve).toHaveBeenCalledWith('id.100.40.8.sig', 8, expect.any(Function));
    expect(states.map((state) => state.phase)).toEqual(['loading', 'solving', 'ready']);
  });

  it('hands over the proof only after the minimum fill time (3 s plus a small margin)', async () => {
    const { check, sleeps } = setup();
    check.start();
    const proof = await check.getProof();
    expect(proof).toEqual({ provider: 'pow-sha256', challenge: 'id.100.40.8.sig', nonce: '42' });
    expect(sleeps).toEqual([3250]);
  });

  it('does not wait again once the time has passed', async () => {
    const { check, clock, sleeps } = setup();
    check.start();
    await vi.waitFor(() => {
      expect(check.fillRemainingMs()).toBeGreaterThan(0);
    });
    clock.now += 10_000;
    expect(check.fillRemainingMs()).toBe(0);
    await check.getProof();
    expect(sleeps).toEqual([]);
  });

  it('asks for a new challenge when the solved one is about to expire', async () => {
    const { check, api, clock } = setup();
    check.start();
    await vi.waitFor(() => {
      expect(check.fillRemainingMs()).toBeGreaterThan(0);
    });
    clock.now += 29 * 60 * 1000 + 50_000; // 29 min 50 s after receipt of a 30 min challenge
    await check.getProof();
    expect(api.challenge).toHaveBeenCalledTimes(2);
  });

  it('restart() cancels the running solve and asks again', async () => {
    const cancel = vi.fn();
    let first = true;
    let started = 0;
    const solveCalls = () => started;
    const { check, api } = setup({
      solve: () => {
        started += 1;
        const handle: SolveHandle = first
          ? { promise: new Promise<never>(() => undefined), cancel }
          : { promise: Promise.resolve({ nonce: '7', attempts: 8 }), cancel: vi.fn() };
        first = false;
        return handle;
      },
    });
    check.start();
    await vi.waitFor(() => {
      expect(api.challenge).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(solveCalls()).toBe(1);
    });
    check.restart();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect((await check.getProof()).nonce).toBe('7');
    expect(api.challenge).toHaveBeenCalledTimes(2);
  });

  it('reports a failed challenge request, rejects getProof and tries afresh on the next call', async () => {
    let calls = 0;
    const { check, states } = setup({
      challenge: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new PortalApiError(429, 'rate_limited', 120))
          : Promise.resolve(CHALLENGE);
      },
    });
    check.start();
    await expect(check.getProof()).rejects.toBeInstanceOf(PortalApiError);
    expect(states.some((state) => state.phase === 'failed')).toBe(true);
    await expect(check.getProof()).resolves.toMatchObject({ nonce: '42' });
  });

  it('stays quiet after dispose and ignores the cancelled solve', async () => {
    const { check, states } = setup({
      solve: () => ({
        promise: Promise.reject(new PowAbortedError()),
        cancel: vi.fn(),
      }),
    });
    check.start();
    check.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(states.every((state) => state.phase !== 'failed')).toBe(true);
  });
});

describe('submitRequest', () => {
  const payload: SubmitPayload = {
    email: 'a@example.com',
    name: 'A',
    category: 'question',
    description: 'Hello',
    website: '',
  };
  const proof = { provider: 'pow-sha256' as const, challenge: 'c', nonce: '1' };
  const submitted = {
    ticketKey: 'OPS-1',
    maskedEmail: 'a***@example.com',
    status: 'received' as const,
    expectedFirstResponseAt: null,
  };

  it('sends the payload with the proof and returns the answer', async () => {
    const submit = vi.fn(() => Promise.resolve(submitted));
    const result = await submitRequest(
      {
        api: { submit },
        check: { getProof: () => Promise.resolve(proof), fillRemainingMs: () => 0 },
      },
      payload,
    );
    expect(result).toBe(submitted);
    expect(submit).toHaveBeenCalledWith({ ...payload, verification: proof });
  });

  it('waits and resends the same challenge once when the api says too quick and our timer agrees', async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new PortalApiError(400, 'verification_failed', null))
      .mockResolvedValueOnce(submitted);
    const sleep = vi.fn(() => Promise.resolve());
    const result = await submitRequest(
      {
        api: { submit },
        check: { getProof: () => Promise.resolve(proof), fillRemainingMs: () => 1500 },
        sleep,
      },
      payload,
    );
    expect(result).toBe(submitted);
    expect(sleep).toHaveBeenCalledWith(1500);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]).toEqual(submit.mock.calls[0]);
  });

  it('throws a real verification failure for the page to start over with a new challenge', async () => {
    const submit = vi.fn(() =>
      Promise.reject(new PortalApiError(400, 'verification_failed', null)),
    );
    await expect(
      submitRequest(
        {
          api: { submit },
          check: { getProof: () => Promise.resolve(proof), fillRemainingMs: () => 0 },
        },
        payload,
      ),
    ).rejects.toMatchObject({ code: 'verification_failed' });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('throws a rate limit untouched', async () => {
    const submit = vi.fn(() => Promise.reject(new PortalApiError(429, 'rate_limited', 600)));
    await expect(
      submitRequest(
        {
          api: { submit },
          check: { getProof: () => Promise.resolve(proof), fillRemainingMs: () => 0 },
        },
        payload,
      ),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 600 });
  });
});
