// The pieces of the gmail-tunnel container (ADR-020), kept free of side effects so they can be tested:
// read the quick-tunnel URL cloudflared prints, sign in to Google as the subscription-admin service
// account, and point the Pub/Sub push subscription at the new URL. Plain Node, no dependencies.
//
// The OIDC audience stays the fixed GMAIL_PUSH_AUDIENCE the api already checks; only the endpoint
// changes, so the api needs no restart when the random URL changes.
import { createSign } from 'node:crypto';

export const PUSH_PATH = '/v1/inbound/gmail/push';
export const TOKEN_URI = 'https://oauth2.googleapis.com/token';
export const PUBSUB_SCOPE = 'https://www.googleapis.com/auth/pubsub';
const PUBSUB_API = 'https://pubsub.googleapis.com/v1';

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
// Pub/Sub resource ids: letters, digits and - _ . ~ + %, starting with a letter (project ids are stricter).
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const SUBSCRIPTION_ID = /^[A-Za-z][A-Za-z0-9\-_.~+%]{2,254}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The quick-tunnel URL in one line of cloudflared's log, or null. */
export function parseTunnelUrl(line) {
  const match = TUNNEL_URL.exec(line);
  return match === null ? null : match[0];
}

/** Checks the settings the container runs with; throws with the name of the first bad one (never its value). */
export function readSettings(env) {
  const project = env.PUBSUB_PROJECT_ID ?? '';
  const subscription = env.GMAIL_TUNNEL_SUBSCRIPTION || 'gmail-push-sub';
  const audience = env.GMAIL_PUSH_AUDIENCE ?? '';
  const pushServiceAccount = env.GMAIL_PUSH_SERVICE_ACCOUNT ?? '';
  if (!PROJECT_ID.test(project))
    throw new Error('PUBSUB_PROJECT_ID is missing or not a project id');
  if (!SUBSCRIPTION_ID.test(subscription))
    throw new Error('GMAIL_TUNNEL_SUBSCRIPTION is not a subscription id');
  if (audience.trim() === '') throw new Error('GMAIL_PUSH_AUDIENCE is not set');
  if (!EMAIL.test(pushServiceAccount))
    throw new Error('GMAIL_PUSH_SERVICE_ACCOUNT is not an email');
  return { project, subscription, audience, pushServiceAccount };
}

/** The fields of a service-account key file that signing needs; rejects anything that is not one. */
export function parseServiceAccountKey(text) {
  let key;
  try {
    key = JSON.parse(text);
  } catch {
    throw new Error('the key file is not JSON');
  }
  if (key?.type !== 'service_account') throw new Error('the key file is not a service account key');
  if (typeof key.client_email !== 'string' || !EMAIL.test(key.client_email)) {
    throw new Error('the key file has no client_email');
  }
  if (typeof key.private_key !== 'string' || !key.private_key.includes('PRIVATE KEY')) {
    throw new Error('the key file has no private_key');
  }
  // Only Google's token endpoint: a key file cannot send the signed assertion anywhere else.
  if (key.token_uri !== undefined && key.token_uri !== TOKEN_URI) {
    throw new Error('the key file names another token endpoint');
  }
  return { clientEmail: key.client_email, privateKey: key.private_key };
}

const base64url = (value) => Buffer.from(value).toString('base64url');

/** A signed JWT bearer assertion (RFC 7523) for Google's OAuth token endpoint. */
export function signAssertion(key, nowSeconds) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: key.clientEmail,
      scope: PUBSUB_SCOPE,
      aud: TOKEN_URI,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(key.privateKey).toString('base64url')}`;
}

/** An access token for Pub/Sub. Errors carry the HTTP status only, never a body. */
export async function fetchAccessToken(fetchFn, key, nowSeconds) {
  const response = await fetchFn(TOKEN_URI, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signAssertion(key, nowSeconds),
    }).toString(),
  });
  if (!response.ok) throw new Error(`token request failed: HTTP ${String(response.status)}`);
  const body = await response.json();
  if (typeof body?.access_token !== 'string') throw new Error('token response has no access_token');
  return body.access_token;
}

/** The body of `subscriptions.modifyPushConfig`: the new endpoint, the same OIDC identity and audience. */
export function buildPushConfig(tunnelUrl, settings) {
  return {
    pushConfig: {
      pushEndpoint: `${tunnelUrl}${PUSH_PATH}`,
      oidcToken: {
        serviceAccountEmail: settings.pushServiceAccount,
        audience: settings.audience,
      },
    },
  };
}

/** Points the push subscription at `tunnelUrl`. */
export async function modifyPushConfig(fetchFn, accessToken, tunnelUrl, settings) {
  if (parseTunnelUrl(tunnelUrl) !== tunnelUrl) throw new Error('not a quick-tunnel URL');
  const name = `projects/${settings.project}/subscriptions/${settings.subscription}`;
  const response = await fetchFn(`${PUBSUB_API}/${name}:modifyPushConfig`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(buildPushConfig(tunnelUrl, settings)),
  });
  if (!response.ok) throw new Error(`modifyPushConfig failed: HTTP ${String(response.status)}`);
}

/**
 * Waits until the tunnel answers from the internet: the filter says 404 to a GET of `/`. A new
 * quick tunnel takes a few seconds before its name resolves.
 */
export async function waitForTunnel(
  fetchFn,
  tunnelUrl,
  { attempts = 30, delayMs = 2000, sleep } = {},
) {
  const pause = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchFn(`${tunnelUrl}/`, { method: 'GET', redirect: 'manual' });
      if (response.status === 404) return true;
    } catch {
      // not resolvable yet
    }
    await pause(delayMs);
  }
  return false;
}

/**
 * After subscribing: a push with a made-up bearer token passes the filter (which answers unsigned
 * requests itself) and must be refused by the api (401), which shows the path reaches the api's
 * verifier. 503 means the api has no push verifier configured.
 */
export async function selfCheck(fetchFn, tunnelUrl) {
  const response = await fetchFn(`${tunnelUrl}${PUSH_PATH}`, {
    method: 'POST',
    headers: { authorization: 'Bearer self-check.not-a-token', 'content-type': 'application/json' },
    body: '{}',
  });
  return response.status;
}
