import { createHash, createHmac } from 'node:crypto';

/**
 * The few object-storage calls the scenario needs (upload its small PNG screenshots), signed with
 * AWS Signature V4 like `createS3ObjectStore` in `@watchtower/channels` (which this package cannot
 * import: channels sits above db). Path-style, one operation, no SDK, and it talks only to the
 * endpoint already configured in `S3_ENDPOINT` (N10).
 */

export interface S3Settings {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
}

export interface SeedObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
}

const sha256Hex = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();
const encodeSegment = (segment: string): string =>
  encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** Settings from the environment, or null when any of them is missing. Never prints a value. */
export function s3SettingsFromEnv(env: NodeJS.ProcessEnv): S3Settings | null {
  const endpoint = env.S3_ENDPOINT;
  const bucket = env.S3_BUCKET;
  const accessKey = env.S3_ACCESS_KEY;
  const secretKey = env.S3_SECRET_KEY;
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  return { endpoint, region: env.S3_REGION || 'us-east-1', bucket, accessKey, secretKey };
}

export function createSeedObjectStore(
  settings: S3Settings,
  doFetch: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): SeedObjectStore {
  const base = new URL(settings.endpoint);
  return {
    async put(key, body, contentType) {
      const path = `${base.pathname.replace(/\/$/, '')}/${encodeSegment(settings.bucket)}/${key
        .split('/')
        .map(encodeSegment)
        .join('/')}`;
      const date = now()
        .toISOString()
        .replace(/[:-]|\.\d{3}/g, '');
      const day = date.slice(0, 8);
      const payloadHash = sha256Hex(body);
      const headers: Record<string, string> = {
        host: base.host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': date,
        'content-type': contentType,
      };
      const names = Object.keys(headers).toSorted();
      const canonicalHeaders = names
        .map((name) => `${name}:${headers[name]?.trim() ?? ''}\n`)
        .join('');
      const signedHeaders = names.join(';');
      const canonicalRequest = ['PUT', path, '', canonicalHeaders, signedHeaders, payloadHash].join(
        '\n',
      );
      const scope = `${day}/${settings.region}/s3/aws4_request`;
      const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join(
        '\n',
      );
      const signingKey = hmac(
        hmac(hmac(hmac(`AWS4${settings.secretKey}`, day), settings.region), 's3'),
        'aws4_request',
      );
      const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
      const authorization = `AWS4-HMAC-SHA256 Credential=${settings.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
      const sendHeaders = Object.fromEntries(
        Object.entries(headers).filter(([name]) => name !== 'host'),
      );
      const response = await doFetch(`${base.origin}${path}`, {
        method: 'PUT',
        headers: { ...sendHeaders, authorization },
        body: Buffer.from(body),
        signal: AbortSignal.timeout(15_000),
      });
      await response.arrayBuffer();
      if (!response.ok)
        throw new Error(`object storage put failed with status ${String(response.status)}`);
    },
  };
}
