/**
 * Routes of this module that anyone may call without signing in, as `METHOD /path` keys exactly
 * as the route-policy test prints them. Adding one is a decision: `auth/routes-policy.test.ts` fails if
 * a public route is missing here, or listed here but not public. A public route must authenticate
 * itself (signature, token) before it acts.
 */
export const ALERTS_PUBLIC_ROUTES: readonly string[] = [
  // Pub/Sub push: authenticated by the OIDC token Pub/Sub signs (T-201c).
  'POST /v1/inbound/alerts/gcp',
  // Alertmanager-compatible webhook: authenticated by the HMAC signature over the raw body (T-201c).
  'POST /v1/inbound/alerts/webhook',
  // Heartbeat signal: same HMAC signature as the webhook, checked before the slug is looked up (T-201e).
  'POST /v1/inbound/heartbeats/:slug',
  // Deploy feed from CI: same HMAC signature, checked before the body is read (T-202a).
  'POST /v1/inbound/deploys',
];
