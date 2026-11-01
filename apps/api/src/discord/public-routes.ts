/**
 * Routes of this module that anyone may call without signing in, as `METHOD /path` keys exactly
 * as the route-policy test prints them (for example `POST /v1/line/webhook`). Adding one is a
 * decision: `auth/routes-policy.test.ts` fails if a public route is missing here, or listed here
 * but not public. A public route must authenticate itself (signature, token) before it acts.
 */
export const DISCORD_PUBLIC_ROUTES: readonly string[] = [
  // Discord interactions: authenticated by the Ed25519 signature over the raw body (T-202b).
  'POST /v1/inbound/discord/interactions',
];
