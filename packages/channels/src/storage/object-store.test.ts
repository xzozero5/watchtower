import { describe, expect, it } from 'vitest';

import { createMemoryObjectStore, createS3ObjectStore, ObjectStoreError } from './object-store.js';

const SETTINGS = {
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  bucket: 'watchtower',
  accessKey: 'minio',
  secretKey: 'not-a-real-secret',
};

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function recordingFetch(respond: (seen: Seen) => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const entry: Seen = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body,
    };
    seen.push(entry);
    return Promise.resolve(respond(entry));
  };
  return { fetch: fakeFetch, seen };
}

describe('S3 object store', () => {
  const now = (): Date => new Date('2026-11-02T03:04:05.678Z');

  it('signs a path-style PUT with SigV4 and never sends the secret', async () => {
    const { fetch: fakeFetch, seen } = recordingFetch(() => new Response(null, { status: 200 }));
    const store = createS3ObjectStore(SETTINGS, { fetch: fakeFetch, now });
    await store.put('raw/gmail/acct/2026/11/g-1.eml', Uint8Array.from([1, 2, 3]), 'message/rfc822');

    expect(seen).toHaveLength(1);
    const request = seen[0];
    expect(request?.url).toBe('http://localhost:9000/watchtower/raw/gmail/acct/2026/11/g-1.eml');
    expect(request?.method).toBe('PUT');
    expect(request?.headers['x-amz-date']).toBe('20261102T030405Z');
    expect(request?.headers['content-type']).toBe('message/rfc822');
    expect(request?.headers['x-amz-content-sha256']).toBe(
      '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
    );
    expect(request?.headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=minio\/20261102\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(JSON.stringify(seen)).not.toContain(SETTINGS.secretKey);
  });

  it('gives a different signature for different content or a different time', async () => {
    const signatures = new Set<string>();
    for (const [body, time] of [
      [[1], '2026-11-02T03:04:05Z'],
      [[2], '2026-11-02T03:04:05Z'],
      [[1], '2026-11-02T03:04:06Z'],
    ] as const) {
      const { fetch: fakeFetch, seen } = recordingFetch(() => new Response(null, { status: 200 }));
      await createS3ObjectStore(SETTINGS, { fetch: fakeFetch, now: () => new Date(time) }).put(
        'k',
        Uint8Array.from(body),
        'text/plain',
      );
      signatures.add(seen[0]?.headers['authorization']?.split('Signature=')[1] ?? '');
    }
    expect(signatures.size).toBe(3);
  });

  it('encodes odd characters in a key as one path segment each', async () => {
    const { fetch: fakeFetch, seen } = recordingFetch(() => new Response(null, { status: 200 }));
    await createS3ObjectStore(SETTINGS, { fetch: fakeFetch, now }).put(
      'a b/ก(1)/c',
      new Uint8Array(),
      'text/plain',
    );
    expect(seen[0]?.url).toBe('http://localhost:9000/watchtower/a%20b/%E0%B8%81%281%29/c');
  });

  it('reads an object, reports a missing one as null, and fails loudly otherwise', async () => {
    const found = createS3ObjectStore(SETTINGS, {
      fetch: recordingFetch(() => new Response(Uint8Array.from([7, 8]), { status: 200 })).fetch,
      now,
    });
    expect(await found.get('k')).toEqual(Uint8Array.from([7, 8]));
    const missing = createS3ObjectStore(SETTINGS, {
      fetch: recordingFetch(() => new Response('<Error/>', { status: 404 })).fetch,
      now,
    });
    expect(await missing.get('k')).toBeNull();
    const denied = createS3ObjectStore(SETTINGS, {
      fetch: recordingFetch(() => new Response('', { status: 403 })).fetch,
      now,
    });
    await expect(denied.get('k')).rejects.toMatchObject({ name: 'ObjectStoreError', status: 403 });
    await expect(denied.put('k', new Uint8Array(), 'text/plain')).rejects.toBeInstanceOf(
      ObjectStoreError,
    );
  });

  it('turns a network failure into an ObjectStoreError without the cause text', async () => {
    const store = createS3ObjectStore(SETTINGS, {
      fetch: () => Promise.reject(new Error('connect ECONNREFUSED secret-host:9000')),
      now,
    });
    const error = await store
      .put('k', new Uint8Array(), 'text/plain')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ObjectStoreError);
    expect((error as Error).message).not.toContain('secret-host');
  });

  it('streams an object with its size, answers null for a missing one, and fails on an error', async () => {
    const found = createS3ObjectStore(SETTINGS, {
      fetch: () =>
        Promise.resolve(
          new Response(Uint8Array.from([1, 2, 3]), { headers: { 'content-length': '3' } }),
        ),
      now,
    });
    const opened = await found.getStream('k');
    expect(opened?.size).toBe(3);
    const chunks: Buffer[] = [];
    for await (const chunk of opened?.stream ?? []) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
    const missing = createS3ObjectStore(SETTINGS, {
      fetch: () => Promise.resolve(new Response(null, { status: 404 })),
      now,
    });
    expect(await missing.getStream('k')).toBeNull();
    const denied = createS3ObjectStore(SETTINGS, {
      fetch: () => Promise.resolve(new Response('no', { status: 403 })),
      now,
    });
    await expect(denied.getStream('k')).rejects.toMatchObject({ status: 403 });
  });

  it('deletes, and treats a missing object as deleted', async () => {
    const { fetch: fakeFetch, seen } = recordingFetch(() => new Response(null, { status: 404 }));
    await createS3ObjectStore(SETTINGS, { fetch: fakeFetch, now }).delete('k');
    expect(seen[0]?.method).toBe('DELETE');
  });
});

describe('memory object store', () => {
  it('stores copies, so a caller cannot change what was stored', async () => {
    const store = createMemoryObjectStore();
    const bytes = Uint8Array.from([1, 2]);
    await store.put('k', bytes, 'text/plain');
    bytes[0] = 9;
    expect(await store.get('k')).toEqual(Uint8Array.from([1, 2]));
    const opened = await store.getStream('k');
    const chunks: Buffer[] = [];
    for await (const chunk of opened?.stream ?? []) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2]));
    await store.delete('k');
    expect(await store.get('k')).toBeNull();
    expect(await store.getStream('k')).toBeNull();
  });
});
