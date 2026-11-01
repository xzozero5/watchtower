import { describe, expect, it } from 'vitest';

import { ChannelError } from '../common/errors.js';
import type { FetchLike } from '../common/http.js';
import {
  GMAIL_OAUTH_HOSTS,
  GMAIL_OAUTH_SCOPES,
  GMAIL_PROFILE_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  buildAuthorizationUrl,
  createOAuthState,
  createOAuthTokenProvider,
  createPkcePair,
  exchangeAuthorizationCode,
  fetchGrantedMailbox,
  grantedScopesAreExact,
  refreshAccessToken,
  revokeToken,
} from './oauth.js';

// The OAuth helpers over a scripted fetch. Values are markers so a leak into an error is visible.
const CLIENT = { clientId: 'client-id-marker', clientSecret: 'CLIENT-SECRET-MARKER-8c1' };
const REFRESH = 'REFRESH-TOKEN-MARKER-5d2';
const ACCESS = 'ACCESS-TOKEN-MARKER-77a';
const SCOPE = GMAIL_OAUTH_SCOPES.join(' ');
const NOW = 1_800_000_000_000;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Seen {
  url: string;
  body: URLSearchParams;
  headers: Record<string, string>;
}

function scripted(...responses: (Response | Error)[]): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const queue = [...responses];
  const fetch: FetchLike = (url, init) => {
    seen.push({
      url,
      body: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error('unscripted fetch');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { fetch, seen };
}

function caught(promise: Promise<unknown>): Promise<ChannelError> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(ChannelError);
      return error as ChannelError;
    },
  );
}

describe('authorization URL', () => {
  it('asks for exactly the two scopes, offline access, forced consent and an S256 challenge', () => {
    const pkce = createPkcePair();
    const url = new URL(
      buildAuthorizationUrl({
        clientId: CLIENT.clientId,
        redirectUri: 'https://api.example.com/cb',
        state: 'st',
        codeChallenge: pkce.challenge,
        loginHint: 'support@example.com',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('scope')).toBe(SCOPE);
    expect(p.get('scope')?.split(' ')).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ]);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toBe(pkce.challenge);
    expect(p.get('state')).toBe('st');
    expect(p.get('include_granted_scopes')).toBeNull();
    // Nothing secret travels in the browser URL.
    expect(url.toString()).not.toContain(CLIENT.clientSecret);
  });

  it('builds a PKCE pair whose challenge is the S256 hash of a 43 to 128 character verifier', async () => {
    const { createHash } = await import('node:crypto');
    const pair = createPkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.verifier.length).toBeLessThanOrEqual(128);
    expect(pair.challenge).toBe(createHash('sha256').update(pair.verifier).digest('base64url'));
    expect(createPkcePair().verifier).not.toBe(pair.verifier);
    expect(createOAuthState()).not.toBe(createOAuthState());
  });

  it('names only Google hosts', () => {
    expect([...GMAIL_OAUTH_HOSTS].sort()).toEqual([
      'accounts.google.com',
      'gmail.googleapis.com',
      'oauth2.googleapis.com',
    ]);
    expect(new URL(GOOGLE_OAUTH_TOKEN_URL).host).toBe('oauth2.googleapis.com');
    expect(new URL(GMAIL_PROFILE_URL).host).toBe('gmail.googleapis.com');
  });
});

describe('grantedScopesAreExact', () => {
  it('accepts the two scopes in any order and refuses fewer, more or different', () => {
    const [read, send] = GMAIL_OAUTH_SCOPES;
    expect(grantedScopesAreExact([read, send])).toBe(true);
    expect(grantedScopesAreExact([send, read])).toBe(true);
    expect(grantedScopesAreExact([read])).toBe(false);
    expect(grantedScopesAreExact([read, send, 'https://mail.google.com/'])).toBe(false);
    expect(grantedScopesAreExact([read, 'https://www.googleapis.com/auth/gmail.modify'])).toBe(
      false,
    );
    expect(grantedScopesAreExact([])).toBe(false);
  });
});

describe('exchangeAuthorizationCode', () => {
  it('posts the code with the verifier and returns the tokens and the granted scopes', async () => {
    const { fetch, seen } = scripted(
      json({
        access_token: ACCESS,
        expires_in: 3599,
        refresh_token: REFRESH,
        scope: SCOPE,
        token_type: 'Bearer',
      }),
    );
    const grant = await exchangeAuthorizationCode({
      ...CLIENT,
      fetch,
      code: 'the-code',
      codeVerifier: 'the-verifier',
      redirectUri: 'https://api.example.com/cb',
    });
    expect(grant).toEqual({
      accessToken: ACCESS,
      expiresInSeconds: 3599,
      refreshToken: REFRESH,
      scopes: [...GMAIL_OAUTH_SCOPES],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(GOOGLE_OAUTH_TOKEN_URL);
    expect(Object.fromEntries(seen[0]?.body ?? [])).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: 'the-verifier',
      redirect_uri: 'https://api.example.com/cb',
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
    });
  });

  it('keeps only a known RFC 6749 error code and never the description', async () => {
    const { fetch } = scripted(
      json({ error: 'invalid_grant', error_description: `leak ${CLIENT.clientSecret}` }, 400),
    );
    const error = await caught(
      exchangeAuthorizationCode({
        ...CLIENT,
        fetch,
        code: 'c',
        codeVerifier: 'v',
        redirectUri: 'https://api.example.com/cb',
      }),
    );
    expect(error.operation).toBe('oauth2.token');
    expect(error.kind).toBe('auth');
    expect(error.code).toBe('invalid_grant');
    expect(error.status).toBe(400);
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(CLIENT.clientSecret);
  });
});

describe('refreshAccessToken failures keep the service-account semantics', () => {
  const run = (response: Response | Error) =>
    caught(refreshAccessToken({ ...CLIENT, refreshToken: REFRESH, ...scripted(response) }));

  it.each([
    ['a dropped connection', new Error(`boom ${REFRESH}`), 'network', undefined],
    ['a 500', json({}, 500), 'server', undefined],
    ['a 429', json({}, 429), 'rate_limited', undefined],
    ['a 401 invalid_client', json({ error: 'invalid_client' }, 401), 'auth', 'invalid_client'],
    [
      'an unknown error name',
      json({ error: 'bring_me_tea' }, 400),
      'auth',
      'token_exchange_refused',
    ],
    [
      'an unreadable 400',
      new Response('<html>', { status: 400 }),
      'auth',
      'token_exchange_refused',
    ],
    ['a 200 without a token', json({ expires_in: 10 }), 'invalid_response', undefined],
    [
      'a 200 with a zero lifetime',
      json({ access_token: 'x', expires_in: 0 }),
      'invalid_response',
      undefined,
    ],
  ] as const)('%s', async (_name, response, kind, code) => {
    const error = await run(response);
    expect(error.operation).toBe('oauth2.token');
    expect(error.kind).toBe(kind);
    expect(error.code).toBe(code);
    // oauth2.token failures are certain non-delivery to the dispatcher; the retryable ones stay retryable.
    expect(error.retryable).toBe(
      kind === 'network' || kind === 'server' || kind === 'rate_limited',
    );
    expect(error.message).not.toContain(REFRESH);
    expect(error.message).not.toContain(CLIENT.clientSecret);
  });
});

describe('createOAuthTokenProvider', () => {
  const credentials = { ...CLIENT, refreshToken: REFRESH };

  it('refreshes with the stored refresh token and caches the access token until a minute before expiry', async () => {
    const { fetch, seen } = scripted(
      json({ access_token: 'one', expires_in: 3600, scope: SCOPE }),
      json({ access_token: 'two', expires_in: 3600, scope: SCOPE }),
    );
    let now = NOW;
    const provider = createOAuthTokenProvider({
      readCredentials: () => Promise.resolve(credentials),
      fetch,
      now: () => now,
    });
    expect(await provider()).toBe('one');
    expect(await provider()).toBe('one');
    expect(seen).toHaveLength(1);
    expect(Object.fromEntries(seen[0]?.body ?? [])).toEqual({
      grant_type: 'refresh_token',
      refresh_token: REFRESH,
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
    });
    now += 3600_000 - 61_000;
    expect(await provider()).toBe('one');
    now += 2_000;
    expect(await provider()).toBe('two');
    expect(seen).toHaveLength(2);
  });

  it('mints one token at a time and again on forceRefresh', async () => {
    const { fetch, seen } = scripted(
      json({ access_token: 'one', expires_in: 3600 }),
      json({ access_token: 'two', expires_in: 3600 }),
    );
    const provider = createOAuthTokenProvider({
      readCredentials: () => Promise.resolve(credentials),
      fetch,
      now: () => NOW,
    });
    expect(await Promise.all([provider(), provider(), provider()])).toEqual(['one', 'one', 'one']);
    expect(seen).toHaveLength(1);
    expect(await provider({ forceRefresh: true })).toBe('two');
  });

  it('turns invalid_grant into an auth ChannelError of oauth2.token, calls the hook, and does not cache a token', async () => {
    const { fetch, seen } = scripted(
      json({ access_token: 'one', expires_in: 120 }),
      json({ error: 'invalid_grant' }, 400),
      json({ access_token: 'three', expires_in: 3600 }),
    );
    let now = NOW;
    let hooked = 0;
    const provider = createOAuthTokenProvider({
      readCredentials: () => Promise.resolve(credentials),
      fetch,
      now: () => now,
      onInvalidGrant: () => {
        hooked += 1;
        return Promise.reject(new Error('the hook failing changes nothing'));
      },
    });
    expect(await provider()).toBe('one');
    now += 100_000;
    const error = await caught(provider());
    expect(error.operation).toBe('oauth2.token');
    expect(error.kind).toBe('auth');
    expect(error.code).toBe('invalid_grant');
    expect(error.retryable).toBe(false);
    expect(hooked).toBe(1);
    // After the reconnect the same provider works again.
    expect(await provider()).toBe('three');
    expect(seen).toHaveLength(3);
  });

  it('does not call the hook for other failures', async () => {
    const { fetch } = scripted(json({}, 503), json({ error: 'invalid_client' }, 401));
    let hooked = 0;
    const provider = createOAuthTokenProvider({
      readCredentials: () => Promise.resolve(credentials),
      fetch,
      now: () => NOW,
      onInvalidGrant: () => {
        hooked += 1;
        return Promise.resolve();
      },
    });
    expect((await caught(provider())).kind).toBe('server');
    expect((await caught(provider())).code).toBe('invalid_client');
    expect(hooked).toBe(0);
  });

  it('reports an unreadable credential store as a retryable server error without its reason', async () => {
    const provider = createOAuthTokenProvider({
      readCredentials: () => Promise.reject(new Error(`db down ${REFRESH}`)),
      fetch: scripted().fetch,
    });
    const error = await caught(provider());
    expect(error.operation).toBe('oauth2.token');
    expect(error.kind).toBe('server');
    expect(error.code).toBe('credentials_unreadable');
    expect(error.message).not.toContain(REFRESH);
  });
});

describe('fetchGrantedMailbox', () => {
  it('reads the profile address, lower-cased, with a bearer token', async () => {
    const calls: { url: string; auth: string | undefined }[] = [];
    const fetch: FetchLike = (url, init) => {
      calls.push({
        url,
        auth: (init?.headers as Record<string, string> | undefined)?.authorization,
      });
      return Promise.resolve(json({ emailAddress: 'Support@Example.com', messagesTotal: 3 }));
    };
    expect(await fetchGrantedMailbox({ fetch, accessToken: ACCESS })).toBe('support@example.com');
    expect(calls).toEqual([{ url: GMAIL_PROFILE_URL, auth: `Bearer ${ACCESS}` }]);
  });

  it.each([
    [json({}, 401), 'auth'],
    [json({}, 503), 'server'],
    [json({ emailAddress: 'nope' }), 'invalid_response'],
    [new Error(ACCESS), 'network'],
  ] as const)('maps %# to %s without echoing the token', async (response, kind) => {
    const error = await caught(fetchGrantedMailbox({ ...scripted(response), accessToken: ACCESS }));
    expect(error.operation).toBe('users.getProfile');
    expect(error.kind).toBe(kind);
    expect(error.message).not.toContain(ACCESS);
  });
});

describe('revokeToken', () => {
  it('posts the token to the revoke endpoint and never throws', async () => {
    const ok = scripted(new Response('', { status: 200 }));
    expect(await revokeToken({ fetch: ok.fetch, token: REFRESH })).toBe(true);
    expect(ok.seen[0]?.url).toBe('https://oauth2.googleapis.com/revoke');
    expect(ok.seen[0]?.body.get('token')).toBe(REFRESH);
    expect(await revokeToken({ ...scripted(new Error('down')), token: REFRESH })).toBe(false);
    expect(await revokeToken({ ...scripted(json({}, 400)), token: REFRESH })).toBe(false);
  });
});
