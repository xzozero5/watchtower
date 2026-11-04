/**
 * Routes of this module that anyone may call without signing in, as `METHOD /path` keys exactly
 * as the route-policy test prints them. Adding one is a decision: `auth/routes-policy.test.ts` fails if a
 * public route is missing here, or listed here but not public. A public route must authenticate itself
 * before it acts.
 *
 * The page itself needs nothing but the owner having opened it (`STATUS_PAGE_PUBLIC`; closed = 404 on every
 * route here); the three subscription routes authenticate with a signed token in the body, or, to ask for a
 * new one, need a proof of work (ADR-007) and are limited per caller, per address, per domain and overall.
 */
export const STATUSPAGE_PUBLIC_ROUTES: readonly string[] = [
  'GET /v1/status',
  'GET /v1/status/history',
  'GET /v1/status/subscriptions/challenge',
  'POST /v1/status/subscriptions',
  'POST /v1/status/subscriptions/confirm',
  'POST /v1/status/subscriptions/unsubscribe',
  'POST /v1/status/subscriptions/unsubscribe/one-click',
];
