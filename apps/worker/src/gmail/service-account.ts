import { createSign } from 'node:crypto';

import { ChannelError, type FetchLike, type TokenProvider } from '@watchtower/channels';
import { z } from 'zod';

/**
 * Access tokens for the Gmail API from a service account with domain-wide delegation (PRD R-2.4
 * `[ASSUMED]`): sign a JWT assertion with the account's private key and exchange it at Google's
 * token endpoint. Hand-written with `node:crypto` so no Google client library (and no credential
 * probe such as Application Default Credentials) is pulled in; `fetch` is injected.
 *
 * Checked against https://developers.google.com/identity/protocols/oauth2/service-account on
 * 2026-11-01 `[CONFIRMED]`: header `alg` RS256 and `typ` JWT (`kid` optional); claims `iss` (service
 * account email), `sub` (the user to impersonate, for delegation), `scope`, `aud`
 * (`https://oauth2.googleapis.com/token`), `iat`, `exp` (at most 1 hour after `iat`); POST
 * form-encoded `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and `assertion`; the response
 * has `access_token`, `token_type`, `expires_in`. Never exercised against Google by this repository
 * `[ASK-HUMAN]` before the first live run.
 *
 * Nothing here is ever logged or put in an error: not the key, not the assertion, not the token.
 */

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/**
 * Least privilege for domain-wide delegation (PRD R-2.4 had `gmail.modify` `[ASSUMED]`). The live
 * transport calls only users.history.list, users.messages.list/get, users.messages.send, users.watch
 * and users.stop. Official reference pages read 2026-11-01 `[CONFIRMED]`: history.list, messages.get,
 * watch and stop each accept `gmail.readonly` (among others); messages.send accepts `gmail.send`.
 * `[VERIFY]` that `format=raw` of messages.get works with `gmail.readonly` on the first live run (the
 * page does not tie `raw` to a scope; `gmail.metadata` cannot return bodies, `readonly` can).
 * Nothing needs `gmail.modify` (labels, trash, delete), `gmail.compose` or `https://mail.google.com/`.
 */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');

const serviceAccountKeySchema = z.object({
  client_email: z.string().min(3),
  private_key: z.string().min(50),
  private_key_id: z.string().optional(),
});

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

export interface ServiceAccountCredentials {
  /** The content of the service account key file (JSON). */
  readonly serviceAccountJson: string;
  /** The mailbox the delegated token acts for. */
  readonly impersonateUser: string;
}

export interface ServiceAccountTokenOptions {
  /** Called whenever a token is minted, so a rotated credential is picked up without a restart. */
  readonly readCredentials: () => Promise<ServiceAccountCredentials>;
  readonly fetch: FetchLike;
  readonly now?: () => number;
  /** Default 10 s. */
  readonly timeoutMs?: number;
  readonly scope?: string;
}

const authFailure = (code: string, status?: number): ChannelError =>
  new ChannelError({
    provider: 'gmail',
    operation: 'oauth2.token',
    kind: 'auth',
    code,
    ...(status === undefined ? {} : { status }),
  });

const base64Url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

/** The signed assertion (exported for the unit test). */
export function signAssertion(
  key: z.infer<typeof serviceAccountKeySchema>,
  subject: string,
  nowMs: number,
  scope: string,
): string {
  const iat = Math.floor(nowMs / 1000);
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    ...(key.private_key_id === undefined ? {} : { kid: key.private_key_id }),
  };
  const claims = {
    iss: key.client_email,
    sub: subject,
    scope,
    aud: GOOGLE_TOKEN_URL,
    iat,
    exp: iat + 3600,
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key);
  return `${unsigned}.${base64Url(signature)}`;
}

/** A `TokenProvider` that caches the token until a minute before it expires and mints one at a time. */
export function createServiceAccountTokenProvider(
  options: ServiceAccountTokenOptions,
): TokenProvider {
  const now = options.now ?? Date.now;
  let cached: { token: string; expiresAtMs: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function mint(): Promise<string> {
    const credentials = await options.readCredentials();
    let key;
    try {
      key = serviceAccountKeySchema.parse(JSON.parse(credentials.serviceAccountJson));
    } catch {
      throw authFailure('service_account_key_invalid');
    }
    let assertion: string;
    try {
      assertion = signAssertion(
        key,
        credentials.impersonateUser,
        now(),
        options.scope ?? GMAIL_SCOPES,
      );
    } catch {
      throw authFailure('service_account_key_unusable');
    }
    let response: Response;
    try {
      response = await options.fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch {
      throw new ChannelError({
        provider: 'gmail',
        operation: 'oauth2.token',
        kind: 'network',
      });
    }
    if (!response.ok) {
      // 5xx and 429 are the provider's trouble; 400/401 mean the key or delegation is wrong.
      if (response.status >= 500 || response.status === 429) {
        throw new ChannelError({
          provider: 'gmail',
          operation: 'oauth2.token',
          kind: response.status === 429 ? 'rate_limited' : 'server',
          status: response.status,
        });
      }
      throw authFailure('token_exchange_refused', response.status);
    }
    const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new ChannelError({
        provider: 'gmail',
        operation: 'oauth2.token',
        kind: 'invalid_response',
      });
    }
    cached = {
      token: parsed.data.access_token,
      expiresAtMs: now() + parsed.data.expires_in * 1000,
    };
    return parsed.data.access_token;
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
