import { Inject, Injectable, Optional } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import * as client from 'openid-client';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { TokenService } from './token.service.js';

/** DI token for test hooks of the OIDC client. Production leaves it unset. */
export const OIDC_OPTIONS = Symbol('OIDC_OPTIONS');

export interface OidcOptions {
  /** Identity provider to talk to. Defaults to Google. Tests point it at a local fake provider. */
  readonly issuer?: URL;
}

export interface GoogleIdentity {
  readonly sub: string;
  readonly email: string;
  readonly emailVerified: boolean;
  /** Hosted-domain claim: the Google Workspace domain of the account, absent for consumer accounts. */
  readonly hostedDomain: string | undefined;
  readonly name: string | undefined;
  /** Where to send the browser afterwards. Always a relative path. */
  readonly returnTo: string;
}

export type OidcFailure = 'state_invalid' | 'google_denied' | 'google_unavailable';

export class OidcError extends Error {
  constructor(
    readonly failure: OidcFailure,
    override readonly cause?: unknown,
  ) {
    super(failure);
    this.name = 'OidcError';
  }
}

const GOOGLE_ISSUER = new URL('https://accounts.google.com');
const STATE_PURPOSE = 'oidc-state';
const STATE_TTL_SECONDS = 600;

/** Only a same-site relative path may be a post-login target, never another host. */
export function sanitizeReturnTo(value: string | undefined): string {
  if (!value || value.length > 200) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return '/';
  }
  return value;
}

/**
 * Google sign-in for staff: OpenID Connect authorization code flow with PKCE (S256), state and
 * nonce, through the `openid-client` library (which checks issuer, audience, expiry and nonce).
 * OpenID Connect Core 3.1.3.7 lets a client skip the ID token signature when the token arrives
 * straight from the token endpoint over TLS, and openid-client does skip it. We verify it anyway
 * against the provider's JWKS (jose), so a TLS-intercepting proxy or a misconfigured endpoint
 * cannot mint a staff identity. The browser-bound state lives in a signed, short-lived HttpOnly
 * cookie, so a callback that did not start in this browser is rejected.
 *
 * The domain and verified-email checks are NOT here: AuthService applies them to the identity this
 * class returns, so they are unit-testable without a provider.
 *
 * Only used when GOOGLE_OIDC_CLIENT_ID and _SECRET are both set (googleMode `live`). In mock mode
 * nothing here runs and nothing leaves the machine. The only outbound request is the OIDC
 * discovery document (https://accounts.google.com/.well-known/openid-configuration) and the
 * token and JWKS endpoints it names.
 */
@Injectable()
export class GoogleOidcService {
  private readonly issuer: URL;
  private discovered: Promise<client.Configuration> | undefined;
  private jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Optional() @Inject(OIDC_OPTIONS) options?: OidcOptions,
  ) {
    this.issuer = options?.issuer ?? GOOGLE_ISSUER;
  }

  get live(): boolean {
    return this.config.googleMode === 'live';
  }

  get redirectUri(): string {
    return new URL('/v1/auth/google/callback', this.config.API_URL).toString();
  }

  private configuration(): Promise<client.Configuration> {
    const { GOOGLE_OIDC_CLIENT_ID: id, GOOGLE_OIDC_CLIENT_SECRET: secret } = this.config;
    if (!this.live || !id || !secret) throw new OidcError('google_unavailable');
    this.discovered ??= client
      .discovery(
        this.issuer,
        id,
        secret,
        undefined,
        // Plain http is accepted only for a local fake provider in tests; Google is always https.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        this.issuer.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((error: unknown) => {
        this.discovered = undefined;
        throw new OidcError('google_unavailable', error);
      });
    return this.discovered;
  }

  /** The Google URL to send the browser to, and the cookie value that binds the flow to it. */
  async start(
    returnTo: string | undefined,
  ): Promise<{ readonly url: string; readonly cookie: string }> {
    const configuration = await this.configuration();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.redirectUri,
      scope: 'openid email profile',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
      // A hint that pre-selects the Workspace domain. It is not a control: the server checks the
      // `hd` claim of the ID token itself. Left out while an email allow-list is set, because
      // the hint would keep personal accounts (no `hd`) from being offered at all.
      ...(this.config.GOOGLE_ALLOWED_EMAILS.length === 0 ? { hd: this.config.staffDomain } : {}),
      prompt: 'select_account',
    });
    const cookie = await this.tokens.signCookieValue(
      STATE_PURPOSE,
      { state, nonce, verifier, returnTo: sanitizeReturnTo(returnTo) },
      STATE_TTL_SECONDS,
    );
    return { url: url.toString(), cookie };
  }

  private async verifySignature(
    configuration: client.Configuration,
    idToken: string | undefined,
  ): Promise<void> {
    const metadata = configuration.serverMetadata();
    if (!idToken || !metadata.jwks_uri) throw new Error('no ID token or no jwks_uri');
    this.jwks ??= createRemoteJWKSet(new URL(metadata.jwks_uri));
    await jwtVerify(idToken, this.jwks, {
      issuer: metadata.issuer,
      audience: this.config.GOOGLE_OIDC_CLIENT_ID ?? '',
      algorithms: ['RS256'],
    });
  }

  /** Exchanges the code (with the PKCE verifier) and returns the verified ID token claims. */
  async finish(query: URLSearchParams, stateCookie: string | undefined): Promise<GoogleIdentity> {
    const saved = stateCookie
      ? await this.tokens.verifyCookieValue(STATE_PURPOSE, stateCookie)
      : null;
    const { state, nonce, verifier, returnTo } = saved ?? {};
    if (
      typeof state !== 'string' ||
      typeof nonce !== 'string' ||
      typeof verifier !== 'string' ||
      query.get('state') !== state
    ) {
      throw new OidcError('state_invalid');
    }
    if (query.get('error')) throw new OidcError('google_denied');

    const configuration = await this.configuration();
    const callback = new URL(this.redirectUri);
    callback.search = query.toString();
    let claims: client.IDToken | undefined;
    try {
      const tokens = await client.authorizationCodeGrant(configuration, callback, {
        pkceCodeVerifier: verifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
      await this.verifySignature(configuration, tokens.id_token);
    } catch (error) {
      throw new OidcError('google_unavailable', error);
    }
    if (!claims || typeof claims.email !== 'string') throw new OidcError('google_unavailable');
    return {
      sub: claims.sub,
      email: claims.email.trim().toLowerCase(),
      emailVerified: claims.email_verified === true,
      hostedDomain: typeof claims.hd === 'string' ? claims.hd.toLowerCase() : undefined,
      name: typeof claims.name === 'string' ? claims.name : undefined,
      returnTo: sanitizeReturnTo(typeof returnTo === 'string' ? returnTo : undefined),
    };
  }
}
