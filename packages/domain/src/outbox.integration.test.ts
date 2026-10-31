import { QUEUE_NAMES } from '@watchtower/shared';
import { openFields, outboxAad } from '@watchtower/shared/secret-box';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startDomainTest, type DomainTestEnv } from './testing/support.js';

let env: DomainTestEnv;

beforeAll(async () => {
  env = await startDomainTest();
});
afterAll(async () => {
  await env.close();
});

interface OutboxRow {
  readonly job_id: string;
  readonly queue: string;
  readonly status: string;
  readonly payload: Record<string, unknown>;
}

const pending = async (): Promise<OutboxRow[]> =>
  (await env.db.owner.pool.query<OutboxRow>('SELECT job_id, queue, status, payload FROM outbox'))
    .rows;

describe('outbox.enqueue', () => {
  it('writes a pending row in the transaction and seals the secret part', async () => {
    const link = 'https://example.test/track#t=PLAINTEXT-LINK';
    const enqueued = await env.tx((tx) =>
      env.domain.outbox.enqueue(tx, env.domain.config, {
        queue: QUEUE_NAMES.email,
        name: 'send',
        jobId: 'job-seal',
        payload: { kind: 'x' },
        secret: { trackingUrl: link },
      }),
    );
    expect(enqueued).toBe(true);
    const [row, ...rest] = (await pending()).filter((candidate) => candidate.job_id === 'job-seal');
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ queue: QUEUE_NAMES.email, status: 'pending' });
    expect(JSON.stringify(row?.payload)).not.toContain('PLAINTEXT-LINK');
    const sealed = row?.payload.secret;
    expect(typeof sealed).toBe('string');
    const opened = openFields(
      env.domain.config.sealKey,
      String(sealed),
      outboxAad(QUEUE_NAMES.email, 'job-seal'),
    );
    expect(opened).toEqual({ trackingUrl: link });
  });

  it('enqueues a job id once, and leaves nothing when the transaction rolls back', async () => {
    const job = {
      queue: QUEUE_NAMES.email,
      name: 'send',
      jobId: 'job-once',
      payload: {},
    } as const;
    const config = env.domain.config;
    expect(await env.tx((tx) => env.domain.outbox.enqueue(tx, config, job))).toBe(true);
    expect(await env.tx((tx) => env.domain.outbox.enqueue(tx, config, job))).toBe(false);

    await expect(
      env.tx(async (tx) => {
        await env.domain.outbox.enqueue(tx, config, { ...job, jobId: 'job-rolled-back' });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    const ids = (await pending()).map((row) => row.job_id);
    expect(ids.filter((id) => id === 'job-once')).toHaveLength(1);
    expect(ids).not.toContain('job-rolled-back');
  });

  it('refuses an unknown queue and a payload that uses the reserved key', async () => {
    const config = env.domain.config;
    await expect(
      env.tx((tx) =>
        env.domain.outbox.enqueue(tx, config, {
          queue: 'nope' as typeof QUEUE_NAMES.email,
          name: 'x',
          jobId: 'j',
          payload: {},
        }),
      ),
    ).rejects.toThrow('unknown queue');
    await expect(
      env.tx((tx) =>
        env.domain.outbox.enqueue(tx, config, {
          queue: QUEUE_NAMES.email,
          name: 'x',
          jobId: 'j',
          payload: { secret: 'x' },
        }),
      ),
    ).rejects.toThrow('reserved');
  });
});
