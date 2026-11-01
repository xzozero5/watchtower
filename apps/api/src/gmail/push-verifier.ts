import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * Verifies the OIDC token Pub/Sub attaches to a push request (ADR-009, T-102b).
 *
 * Checked against the official documentation on 2026-11-01 `[CONFIRMED]`
 * (https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions):
 *   - the token is in `Authorization: Bearer <JWT>`, RS256, with a `kid`;
 *   - claims: `iss` = `https://accounts.google.com` (the Go sample also accepts `accounts.google.com`),
 *     `aud` = the audience configured on the subscription, `email` = the push service account of the
 *     subscription, `email_verified` = true, `exp` = `iat` + 3600; a token reaching the endpoint may
 *     be up to an hour old.
 * The signing keys are Google's JWKS, `jwks_uri` of https://accounts.google.com/.well-known/openid-configuration
 * = https://www.googleapis.com/oauth2/v3/certs (read 2026-11-01). The documentation page itself does not
 * name the certificate URL `[VERIFY]` against the Google client libraries before the first live run.
 *
 * Nothing in this file fetches by itself: the key source (`keys`) is injected. Tests pass a local
 * key set; only `createGoogleKeySet` reaches Google, and only the api module in live configuration
 * calls it.
 */

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS: readonly string[] = [
  'https://accounts.google.com',
  'accounts.google.com',
];

/** The token is missing, malformed, expired, for another audience or from another account. Never says which. */
export class PushAuthError extends Error {
  constructor() {
    super('push token rejected');
    this.name = 'PushAuthError';
  }
}

/** The key source failed (Google unreachable): not the caller's fault, so not a 401. */
export class PushKeysUnavailableError extends Error {
  constructor() {
    super('push verification keys unavailable');
    this.name = 'PushKeysUnavailableError';
  }
}

export interface PushIdentity {
  /** The service account that signed the push, lower case. */
  readonly email: string;
}

export interface PushTokenVerifier {
  /** Resolves for a valid token; throws `PushAuthError` otherwise (or `PushKeysUnavailableError`). */
  verify(token: string): Promise<PushIdentity>;
}

export interface OidcPushVerifierOptions {
  /** The audience set on the push subscription (usually the public URL of the receiver). */
  readonly audience: string;
  /** The push service account of the subscription. */
  readonly serviceAccountEmail: string;
  readonly keys: JWTVerifyGetKey;
  readonly issuers?: readonly string[];
  /** Allowed clock difference between Pub/Sub and this server. Default 60 s. */
  readonly clockToleranceSeconds?: number;
  readonly now?: () => Date;
}

export function createOidcPushVerifier(options: OidcPushVerifierOptions): PushTokenVerifier {
  const expectedEmail = options.serviceAccountEmail.trim().toLowerCase();
  const issuers = [...(options.issuers ?? GOOGLE_ISSUERS)];
  return {
    async verify(token) {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, options.keys, {
          algorithms: ['RS256'],
          issuer: issuers,
          audience: options.audience,
          clockTolerance: options.clockToleranceSeconds ?? 60,
          requiredClaims: ['exp', 'iat'],
          ...(options.now === undefined ? {} : { currentDate: options.now() }),
        }));
      } catch (error) {
        // Network trouble while fetching Google's keys is ours to retry (Pub/Sub will redeliver on 5xx).
        if (error instanceof joseErrors.JWKSTimeout) throw new PushKeysUnavailableError();
        if (error instanceof joseErrors.JOSEError) throw new PushAuthError();
        throw new PushKeysUnavailableError();
      }
      const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
      if (email === '' || email !== expectedEmail) throw new PushAuthError();
      if (payload.email_verified !== true) throw new PushAuthError();
      return { email };
    },
  };
}

/**
 * Google's signing keys over HTTPS, cached by jose (6 hours, at most one refetch per 30 s). Only
 * the live configuration of the api module calls this; no test does.
 */
export function createGoogleKeySet(): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(GOOGLE_JWKS_URL), {
    timeoutDuration: 5000,
    cooldownDuration: 30_000,
    cacheMaxAge: 6 * 3600 * 1000,
  });
}
