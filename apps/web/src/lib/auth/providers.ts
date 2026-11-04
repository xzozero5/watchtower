import type { AuthConfig } from '@watchtower/shared';

/**
 * The single-sign-on provider the instance uses for staff. This is the only place the provider is
 * named; copy, buttons and links take its name from here, so supporting another OIDC provider
 * later (post-MVP) means changing this file and the api, not the screens. The api decides whether
 * it is live: `config.google.startPath` is null in mock mode.
 */
export const SSO_PROVIDER = { id: 'google', displayName: 'Google' } as const;

/**
 * Where the browser goes to start staff sign-in, or null when the instance has no SSO (mock mode).
 * `returnTo` is a path inside this app; the api refuses anything else.
 */
export function ssoStartUrl(
  apiUrl: string,
  config: AuthConfig,
  returnTo = '/start',
): string | null {
  const startPath = config[SSO_PROVIDER.id].startPath;
  if (startPath === null) return null;
  const url = new URL(startPath, `${apiUrl}/`);
  url.searchParams.set('returnTo', returnTo);
  return url.toString();
}

/** The api route that proves who you are again on the session you already have (T-306a C-5). */
export const STEP_UP_PATH = '/v1/auth/google/step-up';

/**
 * A path the api would accept as `returnTo`: same origin, relative, no control characters, at most 200
 * characters (the api answers anything else with `/`). Returns null instead, so the caller can refuse.
 */
export function safeReturnPath(value: string): string | null {
  if (value.length === 0 || value.length > 200) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return value;
}

/**
 * Where the browser goes for a fresh sign-in of the current session (step-up), coming back to `returnTo`
 * with `stepup=ok|failed` added. Null when the return path is not a safe same-origin path.
 */
export function stepUpUrl(apiUrl: string, returnTo: string): string | null {
  const safe = safeReturnPath(returnTo);
  if (safe === null) return null;
  const url = new URL(STEP_UP_PATH, `${apiUrl}/`);
  url.searchParams.set('returnTo', safe);
  return url.toString();
}

/** What went wrong with an SSO sign-in, named without the provider so the copy stays neutral. */
export type SsoFailure =
  | 'stateInvalid'
  | 'denied'
  | 'unavailable'
  | 'emailNotVerified'
  | 'domainNotAllowed'
  | 'notProvisioned'
  | 'accountDisabled'
  | 'accountMismatch'
  | 'unknown';

/** Codes the api puts in `/login?error=` when a sign-in comes back from the provider failed. */
const SSO_ERROR_CODES: Readonly<Record<string, SsoFailure>> = {
  state_invalid: 'stateInvalid',
  google_denied: 'denied',
  google_unavailable: 'unavailable',
  email_not_verified: 'emailNotVerified',
  domain_not_allowed: 'domainNotAllowed',
  staff_not_provisioned: 'notProvisioned',
  account_disabled: 'accountDisabled',
  account_mismatch: 'accountMismatch',
};

/** The failure named by the `error` query parameter, or null when there is none. */
export function parseSsoError(value: string | null): SsoFailure | null {
  if (value === null || value === '') return null;
  return Object.hasOwn(SSO_ERROR_CODES, value) ? (SSO_ERROR_CODES[value] ?? 'unknown') : 'unknown';
}
