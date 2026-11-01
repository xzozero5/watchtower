import { createVerify, generateKeyPairSync } from 'node:crypto';

import { ChannelError } from '@watchtower/channels';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import {
  GMAIL_SCOPES,
  GOOGLE_TOKEN_URL,
  createServiceAccountTokenProvider,
  signAssertion,
} from './service-account.js';

// The service-account token provider with a key generated here and a scripted fetch. Nothing is
// sent anywhere (disableNetConnect), and the key never appears in an error.
const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_JSON = JSON.stringify({
  client_email: 'watchtower@project-id.iam.gserviceaccount.example.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  private_key_id: 'kid-1',
});
const credentials = { serviceAccountJson: KEY_JSON, impersonateUser: 'support@example.com' };
const NOW = Date.UTC(2030, 0, 7, 3, 0, 0);

function tokenResponse(token: string, expiresIn = 3600): Response {
  return new Response(
    JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: expiresIn }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

describe('signAssertion', () => {
  it('signs a delegated RS256 assertion with the claims Google documents', () => {
    const key = JSON.parse(KEY_JSON) as {
      client_email: string;
      private_key: string;
      private_key_id: string;
    };
    const jwt = signAssertion(key, 'support@example.com', NOW, GMAIL_SCOPES);
    const [header, claims, signature] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      kid: 'kid-1',
    });
    const payload = JSON.parse(Buffer.from(claims, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({
      iss: key.client_email,
      sub: 'support@example.com',
      scope: GMAIL_SCOPES,
      aud: GOOGLE_TOKEN_URL,
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
    });
    const verify = createVerify('RSA-SHA256').update(`${header}.${claims}`);
    expect(verify.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });
});

describe('createServiceAccountTokenProvider', () => {
  it('exchanges the assertion at the token endpoint and caches the token until a minute before it expires', async () => {
    let clock = NOW;
    const calls: { url: string; body: URLSearchParams }[] = [];
    const getToken = createServiceAccountTokenProvider({
      readCredentials: () => Promise.resolve(credentials),
      now: () => clock,
      fetch: (url, init) => {
        calls.push({
          url,
          body: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
        });
        return Promise.resolve(tokenResponse(`token-${calls.length.toString()}`, 3600));
      },
    });
    expect(await getToken()).toBe('token-1');
    expect(calls[0]?.url).toBe(GOOGLE_TOKEN_URL);
    expect(calls[0]?.body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(calls[0]?.body.get('assertion')?.split('.')).toHaveLength(3);

    clock = NOW + 30 * 60_000;
    expect(await getToken()).toBe('token-1');
    expect(calls).toHaveLength(1);
    clock = NOW + 59 * 60_000 + 1;
    expect(await getToken()).toBe('token-2');
    expect(await getToken({ forceRefresh: true })).toBe('token-3');
  });

  it('mints one token at a time', async () => {
    let calls = 0;
    const getToken = createServiceAccountTokenProvider({
      readCredentials: () => Promise.resolve(credentials),
      now: () => NOW,
      fetch: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return tokenResponse('shared');
      },
    });
    const tokens = await Promise.all([getToken(), getToken(), getToken()]);
    expect(tokens).toEqual(['shared', 'shared', 'shared']);
    expect(calls).toBe(1);
  });

  it('maps failures to ChannelError kinds without echoing the key, the assertion or the response', async () => {
    const scenarios: [Response | Error, string][] = [
      [new Response('{"error":"invalid_grant","secret":"leak-1"}', { status: 400 }), 'auth'],
      [new Response('nope', { status: 503 }), 'server'],
      [new Response('slow down', { status: 429 }), 'rate_limited'],
      [new Response('{"unexpected":true}', { status: 200 }), 'invalid_response'],
      [new Error('socket hang up leak-2'), 'network'],
    ];
    for (const [outcome, kind] of scenarios) {
      const getToken = createServiceAccountTokenProvider({
        readCredentials: () => Promise.resolve(credentials),
        now: () => NOW,
        fetch: () =>
          outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome.clone()),
      });
      const error = await getToken().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ChannelError);
      expect((error as ChannelError).kind).toBe(kind);
      const text = `${(error as Error).message} ${JSON.stringify(error)}`;
      expect(text).not.toContain('PRIVATE KEY');
      expect(text).not.toContain('leak-');
    }
  });

  it('reports an unreadable credential as a failure of the token step', async () => {
    const getToken = createServiceAccountTokenProvider({
      readCredentials: () => Promise.reject(new Error('database unavailable')),
      fetch: () => Promise.reject(new Error('must not be called')),
    });
    const error = await getToken().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      operation: 'oauth2.token',
      code: 'credentials_unreadable',
      retryable: true,
    });
  });

  it('rejects a key file that is not a service account key, without reading it back', async () => {
    const getToken = createServiceAccountTokenProvider({
      readCredentials: () =>
        Promise.resolve({
          serviceAccountJson: '{"hello":"world"}',
          impersonateUser: 'a@example.com',
        }),
      fetch: () => Promise.reject(new Error('must not be called')),
    });
    const error = await getToken().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'auth', code: 'service_account_key_invalid' });
  });
});
