import { describe, expect, it } from 'vitest';

import { ApiHttpError } from '../auth/http-errors.js';
import { EgressError, type FetchedImage } from '../egress/safe-fetch.js';
import {
  DEFAULT_REMOTE_IMAGE_LIMITS,
  RemoteImageService,
  type ImageFetcher,
  type RemoteImageLimits,
} from './remote-image.service.js';

const IMAGE: FetchedImage = { bytes: Buffer.alloc(8, 1), contentType: 'image/png' };

/** A fetcher whose calls stay open until the test lets them finish. */
function gate() {
  const open: { url: string; finish: () => void; fail: (reason: EgressError) => void }[] = [];
  let calls = 0;
  const fetcher: ImageFetcher = {
    fetchImage: (url) => {
      calls += 1;
      return new Promise<FetchedImage>((resolve, reject) => {
        open.push({
          url,
          finish: () => {
            resolve(IMAGE);
          },
          fail: reject,
        });
      });
    },
  };
  return { fetcher, open, calls: () => calls };
}

function service(fetcher: ImageFetcher, limits: Partial<RemoteImageLimits> = {}) {
  return new RemoteImageService(fetcher, {
    ...DEFAULT_REMOTE_IMAGE_LIMITS,
    maxConcurrent: 100,
    ...limits,
  });
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiHttpError) return `${String(error.getStatus())}:${error.code}`;
    if (error instanceof EgressError) return `egress:${error.reason}`;
    throw error;
  }
  return 'ok';
}

describe('RemoteImageService limits (T-175a)', () => {
  it('has the defaults: 4 in flight per person, 2 per host, 2 minutes for a failure', () => {
    expect(DEFAULT_REMOTE_IMAGE_LIMITS).toMatchObject({
      maxConcurrentPerUser: 4,
      maxConcurrentPerHost: 2,
      failureTtlMs: 120_000,
    });
  });

  it('lets one person have 4 fetches in flight and refuses the 5th with 429; another person is not affected', async () => {
    const g = gate();
    const images = service(g.fetcher, { maxConcurrentPerHost: 100 });
    const mine = Array.from({ length: 4 }, (_, n) =>
      images.load(`https://h${String(n)}.example.test/a.png`, 'user-1'),
    );
    expect(await code(images.load('https://h9.example.test/a.png', 'user-1'))).toBe(
      '429:rate_limited',
    );
    const other = images.load('https://h8.example.test/a.png', 'user-2');
    expect(g.calls()).toBe(5);
    for (const call of g.open) call.finish();
    await Promise.all([...mine, other]);
    // The slots are given back.
    const again = images.load('https://h7.example.test/a.png', 'user-1');
    g.open.at(-1)?.finish();
    await again;
  });

  it('lets one host have 2 fetches in flight whoever asks, and refuses the 3rd', async () => {
    const g = gate();
    const images = service(g.fetcher);
    const first = images.load('https://img.example.test/1.png', 'user-1');
    const second = images.load('https://img.example.test/2.png', 'user-2');
    expect(await code(images.load('https://IMG.example.test/3.png', 'user-3'))).toBe(
      '429:rate_limited',
    );
    // A different host is fine.
    const elsewhere = images.load('https://other.example.test/1.png', 'user-3');
    for (const call of g.open) call.finish();
    await Promise.all([first, second, elsewhere]);
  });

  it('gives the slots back when a fetch fails', async () => {
    const g = gate();
    const images = service(g.fetcher, { maxConcurrentPerUser: 1 });
    const failing = images.load('https://a.example.test/1.png', 'user-1');
    g.open[0]?.fail(new EgressError('network'));
    expect(await code(failing)).toBe('egress:network');
    const next = images.load('https://b.example.test/1.png', 'user-1');
    g.open[1]?.finish();
    await next;
  });

  it('remembers a failed address for 2 minutes and answers without asking the sender again', async () => {
    const g = gate();
    const images = service(g.fetcher);
    const first = images.load('https://dead.example.test/1.png', 'user-1');
    g.open[0]?.fail(new EgressError('status'));
    expect(await code(first)).toBe('egress:status');
    expect(await code(images.load('https://dead.example.test/1.png', 'user-2'))).toBe(
      'egress:status',
    );
    expect(g.calls()).toBe(1);
    // Another address of the same host is a different question.
    const other = images.load('https://dead.example.test/2.png', 'user-1');
    g.open[1]?.finish();
    await other;
    expect(g.calls()).toBe(2);
  });

  it('asks again once the failure has expired', async () => {
    const g = gate();
    const images = service(g.fetcher, { failureTtlMs: 20 });
    const first = images.load('https://dead.example.test/1.png', 'user-1');
    g.open[0]?.fail(new EgressError('timeout'));
    await code(first);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = images.load('https://dead.example.test/1.png', 'user-1');
    expect(g.calls()).toBe(2);
    g.open[1]?.finish();
    await second;
  });

  it('does not remember our own throttling as a failure of the address', async () => {
    const g = gate();
    const images = service(g.fetcher, { maxConcurrentPerHost: 1 });
    const running = images.load('https://img.example.test/1.png', 'user-1');
    expect(await code(images.load('https://img.example.test/2.png', 'user-2'))).toBe(
      '429:rate_limited',
    );
    g.open[0]?.finish();
    await running;
    const retry = images.load('https://img.example.test/2.png', 'user-2');
    g.open[1]?.finish();
    await retry;
  });

  it('serves a good picture from the cache without using a slot', async () => {
    const g = gate();
    const images = service(g.fetcher, { maxConcurrentPerUser: 1 });
    const first = images.load('https://img.example.test/1.png', 'user-1');
    g.open[0]?.finish();
    await first;
    const cached = await images.load('https://img.example.test/1.png', 'user-1');
    expect(cached.fromCache).toBe(true);
    expect(g.calls()).toBe(1);
  });
});
