import { createHash, randomBytes } from 'node:crypto';

import { ChannelError } from '../common/errors.js';
import type { FetchLike, TokenProvider } from '../common/http.js';

/**
 * OAuth 2.0 for one Gmail mailbox (T-102e): the web server flow (authorization code + PKCE) that a
 * `head` runs once for the support mailbox, and the refresh-token `TokenProvider` the worker uses
 * afterwards. Hand-written over an injected `fetch` (no Google client library, no Application
 * Default Credentials probe), like the service-account provider in `apps/worker`.
 *
 * The only hosts this file talks to, and all of them are Google's:
 *  - `accounts.google.com` (browser redirect only; the server never calls it),
 *  - `oauth2.googleapis.com` (code exchange, refresh, revoke),
 *  - `gmail.googleapis.com` (`users.getProfile`, the same host the Gmail transport uses). The address
 *    comes from there because the scopes below carry no identity (`openid email` is not requested:
 *    the grant is exactly `gmail.readonly` + `gmail.send`).
 * Nothing here accepts a URL from a caller.
 *
 * Checked against official documentation on 2026-11-01 (Asia/Bangkok):
 *  - https://developers.google.com/identity/protocols/oauth2/web-server `[CONFIRMED]`: endpoint
 *    `https://accounts.google.com/o/oauth2/v2/auth`; `response_type=code`, `scope`, `state`,
 *    `access_type=offline` (refresh token on the first exchange), `prompt=consent`, `login_hint`;
 *    token exchange `POST https://oauth2.googleapis.com/token` with `code`, `client_id`,
 *    `client_secret`, `redirect_uri`, `grant_type=authorization_code`; the response carries
 *    `access_token`, `expires_in`, `refresh_token`, `scope` (granted, space-delimited) and
 *    `token_type`; the user may grant fewer scopes than requested, so `scope` must be checked;
 *    `invalid_grant` on refresh = expired or invalidated token.
 *  - https://developers.google.com/identity/protocols/oauth2/native-app `[CONFIRMED]` PKCE:
 *    `code_challenge` + `code_challenge_method` (`S256` or `plain`), a 43 to 128 character verifier,
 *    `code_verifier` on the exchange; refresh = `grant_type=refresh_token`, `refresh_token`,
 *    `client_id`, `client_secret` (optional for some client types). That PKCE is also accepted for a
 *    Web application client with a secret: `[VERIFY]` on the first live run (RFC 7636 says it is).
 *  - https://developers.google.com/identity/protocols/oauth2#expiration `[CONFIRMED]` a refresh token
 *    stops working when: revoked; unused for 6 months; the password changed and it holds Gmail scopes;
 *    more than 100 per account per client; **7 days when the consent screen is External and in
 *    "Testing"**; an admin session policy. All of these surface as `invalid_grant`.
 *  - https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile `[CONFIRMED]`
 *    `GET https://gmail.googleapis.com/gmail/v1/users/{userId}/profile`, authorised by
 *    `gmail.readonly` among others; returns `emailAddress`.
 *  - Revoke `POST https://oauth2.googleapis.com/revoke` (`token`): `[VERIFY]` (documented under
 *    "Revoking a token"; only ever called to undo a refused connection, best effort).
 * Never exercised against Google by this repository `[ASK-HUMAN]` before the first live run.
 *
 * Nothing here is ever logged or put in an error: not the client secret, a code, a verifier or a token.
 */

export const GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_OAUTH_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GMAIL_PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

/** The hosts above, for tests and for any egress allow-list a deployment keeps. */
export const GMAIL_OAUTH_HOSTS = [
  'accounts.google.com',
  'oauth2.googleapis.com',
  'gmail.googleapis.com',
] as const;

/** Exactly what the live transport needs (see `apps/worker/src/gmail/service-account.ts`). */
export const GMAIL_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
] as const;

const DEFAULT_TIMEOUT_MS = 10_000;

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

/** A 43-character verifier (32 random bytes, base64url) and its S256 challenge (RFC 7636). */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** An unguessable value for `state`. */
export function createOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

export interface AuthorizationUrlInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  /** A hint that pre-selects the account. It is not a control: the granted address is checked afterwards. */
  readonly loginHint?: string;
}

/** The URL the browser is sent to. `prompt=consent` + `access_type=offline` so Google issues a refresh token. */
export function buildAuthorizationUrl(input: AuthorizationUrlInput): string {
  const url = new URL(GOOGLE_OAUTH_AUTH_URL);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GMAIL_OAUTH_SCOPES.join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  // Not `include_granted_scopes`: the grant must be exactly the two scopes, not what the account
  // approved for this client earlier.
  if (input.loginHint !== undefined) url.searchParams.set('login_hint', input.loginHint);
  return url.toString();
}

/** True when the granted scopes are exactly the ones this integration asks for (order and duplicates ignored). */
export function grantedScopesAreExact(granted: readonly string[]): boolean {
  const have = new Set(granted);
  return (
    have.size === GMAIL_OAUTH_SCOPES.length && GMAIL_OAUTH_SCOPES.every((scope) => have.has(scope))
  );
}

/** The error codes of RFC 6749 section 5.2 that may be carried into `ChannelError.code`. */
const KNOWN_OAUTH_ERRORS = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
]);

export interface OAuthClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

interface TokenEndpointOptions {
  readonly fetch: FetchLike;
  readonly timeoutMs?: number;
}

export interface TokenGrant {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  /** Absent on a refresh, and on an exchange when Google did not issue one. */
  readonly refreshToken: string | undefined;
  /** The scopes Google says were granted. */
  readonly scopes: readonly string[];
}

const failure = (init: {
  kind: ChannelError['kind'];
  code?: string;
  status?: number;
}): ChannelError =>
  new ChannelError({
    provider: 'gmail',
    // Same operation name as the service-account provider: the dispatcher treats a failure here as a
    // certain non-delivery (the token comes before any send).
    operation: 'oauth2.token',
    kind: init.kind,
    ...(init.code === undefined ? {} : { code: init.code }),
    ...(init.status === undefined ? {} : { status: init.status }),
  });

async function postToken(
  options: TokenEndpointOptions,
  form: Readonly<Record<string, string>>,
): Promise<TokenGrant> {
  let response: Response;
  try {
    response = await options.fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw failure({ kind: 'network' });
  }
  if (!response.ok) {
    if (response.status >= 500 || response.status === 429) {
      throw failure({
        kind: response.status === 429 ? 'rate_limited' : 'server',
        status: response.status,
      });
    }
    // 400 / 401: only the RFC 6749 error code is kept, never `error_description` (free text).
    const body: unknown = await response.json().catch(() => null);
    const code =
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'string' &&
      KNOWN_OAUTH_ERRORS.has(body.error)
        ? body.error
        : 'token_exchange_refused';
    throw failure({ kind: 'auth', code, status: response.status });
  }
  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body !== 'object' ||
    body === null ||
    !('access_token' in body) ||
    typeof body.access_token !== 'string' ||
    body.access_token === '' ||
    !('expires_in' in body) ||
    typeof body.expires_in !== 'number' ||
    !Number.isFinite(body.expires_in) ||
    body.expires_in <= 0
  ) {
    throw failure({ kind: 'invalid_response' });
  }
  const refreshToken =
    'refresh_token' in body && typeof body.refresh_token === 'string' && body.refresh_token !== ''
      ? body.refresh_token
      : undefined;
  const scopes =
    'scope' in body && typeof body.scope === 'string'
      ? body.scope.split(/\s+/).filter((scope) => scope !== '')
      : [];
  return {
    accessToken: body.access_token,
    expiresInSeconds: body.expires_in,
    refreshToken,
    scopes,
  };
}

export interface ExchangeCodeInput extends OAuthClientCredentials, TokenEndpointOptions {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

/** Trades the authorization code (with the PKCE verifier) for tokens. */
export function exchangeAuthorizationCode(input: ExchangeCodeInput): Promise<TokenGrant> {
  return postToken(input, {
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
}

export interface RefreshInput extends OAuthClientCredentials, TokenEndpointOptions {
  readonly refreshToken: string;
}

export function refreshAccessToken(input: RefreshInput): Promise<TokenGrant> {
  return postToken(input, {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
}

/**
 * The address the access token belongs to (`users.getProfile` on `me`), lower-cased. Throws a
 * `ChannelError` (`users.getProfile`) when Google refuses or answers something unreadable.
 */
export async function fetchGrantedMailbox(
  options: TokenEndpointOptions & { readonly accessToken: string },
): Promise<string> {
  const fail = (kind: ChannelError['kind'], status?: number): ChannelError =>
    new ChannelError({
      provider: 'gmail',
      operation: 'users.getProfile',
      kind,
      ...(status === undefined ? {} : { status }),
    });
  let response: Response;
  try {
    response = await options.fetch(GMAIL_PROFILE_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${options.accessToken}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw fail('network');
  }
  if (!response.ok) {
    throw fail(
      response.status >= 500 ? 'server' : response.status === 429 ? 'rate_limited' : 'auth',
      response.status,
    );
  }
  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body !== 'object' ||
    body === null ||
    !('emailAddress' in body) ||
    typeof body.emailAddress !== 'string' ||
    !body.emailAddress.includes('@')
  ) {
    throw fail('invalid_response');
  }
  return body.emailAddress.trim().toLowerCase();
}

/** Best effort: undo a grant we refuse to keep. Never throws, says nothing about the outcome. */
export async function revokeToken(
  options: TokenEndpointOptions & { readonly token: string },
): Promise<boolean> {
  try {
    const response = await options.fetch(GOOGLE_OAUTH_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: options.token }).toString(),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface OAuthMailboxCredentials extends OAuthClientCredentials {
  readonly refreshToken: string;
}

export interface OAuthTokenProviderOptions {
  /** Called whenever a token is minted, so a rotated credential is picked up without a restart. */
  readonly readCredentials: () => Promise<OAuthMailboxCredentials>;
  readonly fetch: FetchLike;
  readonly now?: () => number;
  /** Default 10 s. */
  readonly timeoutMs?: number;
  /**
   * Called (and awaited, errors ignored) when Google answers `invalid_grant`: the refresh token is
   * revoked or expired, so the mailbox is no longer connected until a head connects it again.
   */
  readonly onInvalidGrant?: () => Promise<void>;
}

/**
 * A `TokenProvider` over a refresh token. Same contract as the service-account one: the access token
 * is cached until a minute before it expires and minted one at a time; every failure is a
 * `ChannelError` of operation `oauth2.token`. `invalid_grant` is kind `auth` with that code. It is
 * not turned into a retry here and never falls back to anything else.
 */
export function createOAuthTokenProvider(options: OAuthTokenProviderOptions): TokenProvider {
  const now = options.now ?? Date.now;
  let cached: { token: string; expiresAtMs: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function mint(): Promise<string> {
    let credentials: OAuthMailboxCredentials;
    try {
      credentials = await options.readCredentials();
    } catch {
      throw failure({ kind: 'server', code: 'credentials_unreadable' });
    }
    try {
      const grant = await refreshAccessToken({
        ...credentials,
        fetch: options.fetch,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      cached = { token: grant.accessToken, expiresAtMs: now() + grant.expiresInSeconds * 1000 };
      return grant.accessToken;
    } catch (error) {
      cached = null;
      if (error instanceof ChannelError && error.code === 'invalid_grant') {
        await options.onInvalidGrant?.().catch(() => undefined);
      }
      throw error;
    }
  }

  return async (tokenOptions) => {
    if (
      tokenOptions?.forceRefresh !== true &&
      cached !== null &&
      cached.expiresAtMs - 60_000 > now()
    ) {
      return cached.token;
    }
    inFlight ??= mint().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
