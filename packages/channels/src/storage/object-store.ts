import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

/**
 * Object storage for raw inbound payloads and attachments (ADR-009 step 2). MinIO locally, GCS
 * through its S3-compatible endpoint on GCP. The S3 settings are the ones the config already has
 * (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`); nothing new is
 * added to the environment.
 *
 * A port, so unit tests use `createMemoryObjectStore`. The S3 implementation signs requests with
 * AWS Signature Version 4 itself instead of pulling in an SDK: two operations, path-style, no new
 * dependency and no new network destination (N10; the endpoint is the one already configured).
 */

export interface ObjectStore {
  /** Writes (or overwrites) one object. Keys are deterministic, so a retry writes the same bytes again. */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Reads an object; null when it does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /**
   * Reads an object as a stream, so a download does not hold the whole file in memory (T-155); null when
   * it does not exist. `size` is the byte length when the store says it. Destroy the stream if you stop early.
   */
  getStream(key: string): Promise<ObjectStream | null>;
  /** Deletes an object; deleting one that does not exist is not an error (retention, test cleanup). */
  delete(key: string): Promise<void>;
}

export interface ObjectStream {
  readonly stream: Readable;
  readonly size: number | null;
}

export class ObjectStoreError extends Error {
  readonly status: number | undefined;

  constructor(operation: string, status?: number) {
    super(
      `object storage ${operation} failed${status === undefined ? '' : ` with status ${String(status)}`}`,
    );
    this.name = 'ObjectStoreError';
    this.status = status;
  }
}

export function createMemoryObjectStore(): ObjectStore & {
  readonly objects: ReadonlyMap<string, { body: Uint8Array; contentType: string }>;
} {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  return {
    objects,
    put(key, body, contentType) {
      objects.set(key, { body: Uint8Array.from(body), contentType });
      return Promise.resolve();
    },
    get(key) {
      const found = objects.get(key);
      return Promise.resolve(found === undefined ? null : Uint8Array.from(found.body));
    },
    getStream(key) {
      const found = objects.get(key);
      return Promise.resolve(
        found === undefined
          ? null
          : { stream: Readable.from([Buffer.from(found.body)]), size: found.body.length },
      );
    },
    delete(key) {
      objects.delete(key);
      return Promise.resolve();
    },
  };
}

export interface S3Settings {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
}

export interface S3Options {
  /** Replaces the global `fetch`. Tests use it to watch what is sent; production leaves it unset. */
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  /** Give up on a request after this long. Default 15 s. */
  readonly timeoutMs?: number;
}

const sha256Hex = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding of one path segment, as S3 wants it (no double encoding for S3). */
const encodeSegment = (segment: string): string =>
  encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export function createS3ObjectStore(settings: S3Settings, options: S3Options = {}): ObjectStore {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? ((): Date => new Date());
  const timeoutMs = options.timeoutMs ?? 15_000;
  const base = new URL(settings.endpoint);

  async function request(
    method: 'PUT' | 'GET' | 'DELETE',
    key: string,
    body: Uint8Array | undefined,
    contentType: string | undefined,
  ): Promise<Response> {
    const path = `${base.pathname.replace(/\/$/, '')}/${encodeSegment(settings.bucket)}/${key
      .split('/')
      .map(encodeSegment)
      .join('/')}`;
    const date = now()
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, ''); // 20261101T031500Z
    const day = date.slice(0, 8);
    const payloadHash = sha256Hex(body ?? '');
    const headers: Record<string, string> = {
      host: base.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': date,
    };
    if (contentType !== undefined) headers['content-type'] = contentType;
    const names = Object.keys(headers).toSorted();
    const canonicalHeaders = names
      .map((name) => `${name}:${headers[name]?.trim() ?? ''}\n`)
      .join('');
    const signedHeaders = names.join(';');
    const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join(
      '\n',
    );
    const scope = `${day}/${settings.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${settings.secretKey}`, day), settings.region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${settings.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    // fetch sets Host from the URL itself.
    const sendHeaders = Object.fromEntries(
      Object.entries(headers).filter(([name]) => name !== 'host'),
    );
    return doFetch(`${base.origin}${path}`, {
      method,
      headers: { ...sendHeaders, authorization },
      ...(body === undefined ? {} : { body: Buffer.from(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  return {
    async put(key, body, contentType) {
      let response: Response;
      try {
        response = await request('PUT', key, body, contentType);
      } catch {
        throw new ObjectStoreError('put');
      }
      if (!response.ok) throw new ObjectStoreError('put', response.status);
      await response.arrayBuffer();
    },
    async get(key) {
      let response: Response;
      try {
        response = await request('GET', key, undefined, undefined);
      } catch {
        throw new ObjectStoreError('get');
      }
      if (response.status === 404) {
        await response.arrayBuffer();
        return null;
      }
      if (!response.ok) throw new ObjectStoreError('get', response.status);
      return new Uint8Array(await response.arrayBuffer());
    },
    async getStream(key) {
      let response: Response;
      try {
        response = await request('GET', key, undefined, undefined);
      } catch {
        throw new ObjectStoreError('get');
      }
      if (response.status === 404) {
        await response.arrayBuffer();
        return null;
      }
      if (!response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        throw new ObjectStoreError('get', response.status);
      }
      const length = Number(response.headers.get('content-length'));
      const size = Number.isSafeInteger(length) && length >= 0 ? length : null;
      if (response.body === null) return { stream: Readable.from([]), size: 0 };
      return { stream: Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), size };
    },
    async delete(key) {
      let response: Response;
      try {
        response = await request('DELETE', key, undefined, undefined);
      } catch {
        throw new ObjectStoreError('delete');
      }
      if (!response.ok && response.status !== 404)
        throw new ObjectStoreError('delete', response.status);
      await response.arrayBuffer();
    },
  };
}
