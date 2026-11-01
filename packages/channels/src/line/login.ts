import { randomBytes } from 'node:crypto';

/**
 * LINE Login (R-2.11 route a): a signed-in portal client proves that a LINE account is theirs. The
 * port below is the seam; what this repository ships is the in-memory `FakeLineLoginProvider` that
 * the tests and mock mode use. A live provider (authorization code flow against LINE's OAuth 2.1
 * endpoints, ID token verification) is NOT implemented: it needs a LINE Login channel and a
 * network destination that has not been approved (`[ASK-HUMAN]`, PRD section 11). Until then the
 * api offers LINE Login only in mock mode.
 *
 * Facts to confirm against the official LINE Login docs before the live provider is written
 * `[VERIFY]`: the `sub` claim of the ID token is the LINE user id; it equals the Messaging API user
 * id only when the Login channel and the Official Account belong to the same provider.
 */

export type LineLoginFailure =
  'invalid_code' | 'redirect_uri_mismatch' | 'nonce_mismatch' | 'denied' | 'unavailable';

export class LineLoginError extends Error {
  constructor(readonly failure: LineLoginFailure) {
    super(`LINE Login failed: ${failure}`);
    this.name = 'LineLoginError';
  }
}

export interface LineLoginIdentity {
  /** The LINE user id (`sub`). */
  readonly userId: string;
  readonly displayName: string | null;
}

export interface LineLoginProvider {
  /** The URL to send the browser to. `state` and `nonce` come back (state in the redirect, nonce in the ID token). */
  authorizeUrl(input: {
    readonly state: string;
    readonly nonce: string;
    readonly redirectUri: string;
  }): string;
  /** Trades the one-time code for the identity. Rejects with `LineLoginError`. */
  exchange(input: {
    readonly code: string;
    readonly nonce: string;
    readonly redirectUri: string;
  }): Promise<LineLoginIdentity>;
}

export interface FakeLineLoginOptions {
  /**
   * Mock mode without a person at a consent screen: the authorization URL points straight back to
   * the redirect URI with a fresh code, as if this user had just approved.
   */
  readonly autoConsent?: LineLoginIdentity;
}

interface Grant {
  readonly identity: LineLoginIdentity;
  readonly nonce: string;
  readonly redirectUri: string;
  used: boolean;
}

/** Not a real host and never fetched: the fake only builds the string. */
const FAKE_AUTHORIZE_URL = 'https://login.line.fake.example.test/oauth2/v2.1/authorize';

export class FakeLineLoginProvider implements LineLoginProvider {
  readonly #grants = new Map<string, Grant>();
  readonly #pending = new Map<string, { nonce: string; redirectUri: string }>();
  readonly #auto: LineLoginIdentity | undefined;
  /** Every authorization URL handed out (a test reads state and nonce from here). */
  readonly authorizations: { state: string; nonce: string; url: string }[] = [];

  constructor(options: FakeLineLoginOptions = {}) {
    this.#auto = options.autoConsent;
  }

  authorizeUrl(input: {
    readonly state: string;
    readonly nonce: string;
    readonly redirectUri: string;
  }): string {
    this.#pending.set(input.state, { nonce: input.nonce, redirectUri: input.redirectUri });
    if (this.#auto !== undefined) {
      const code = this.consent(input.state, this.#auto);
      const back = new URL(input.redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', input.state);
      this.authorizations.push({ state: input.state, nonce: input.nonce, url: back.toString() });
      return back.toString();
    }
    const url = new URL(FAKE_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', input.state);
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('redirect_uri', input.redirectUri);
    this.authorizations.push({ state: input.state, nonce: input.nonce, url: url.toString() });
    return url.toString();
  }

  /** The person approved at the consent screen: returns the `code` LINE would put in the redirect. */
  consent(state: string, identity: LineLoginIdentity): string {
    const pending = this.#pending.get(state);
    if (pending === undefined) throw new Error('no authorization request with this state');
    const code = randomBytes(16).toString('hex');
    this.#grants.set(code, {
      identity,
      nonce: pending.nonce,
      redirectUri: pending.redirectUri,
      used: false,
    });
    return code;
  }

  exchange(input: {
    readonly code: string;
    readonly nonce: string;
    readonly redirectUri: string;
  }): Promise<LineLoginIdentity> {
    const grant = this.#grants.get(input.code);
    // A code works once, like the real thing.
    if (grant === undefined || grant.used)
      return Promise.reject(new LineLoginError('invalid_code'));
    grant.used = true;
    if (grant.redirectUri !== input.redirectUri) {
      return Promise.reject(new LineLoginError('redirect_uri_mismatch'));
    }
    if (grant.nonce !== input.nonce) return Promise.reject(new LineLoginError('nonce_mismatch'));
    return Promise.resolve(grant.identity);
  }
}
