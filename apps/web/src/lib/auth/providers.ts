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
