/**
 * Routes of this module that anyone may call without signing in, as `METHOD /path` keys exactly
 * as the route-policy test prints them (for example `POST /v1/line/webhook`). Adding one is a
 * decision: `auth/routes-policy.test.ts` fails if a public route is missing here, or listed here
 * but not public. A public route must authenticate itself (signature, token) before it acts.
 *
 * Both survey routes authenticate with the signed single-use token in `X-Csat-Token`.
 */
export const CSAT_PUBLIC_ROUTES: readonly string[] = [
  'GET /v1/csat/survey',
  'POST /v1/csat/responses',
];
