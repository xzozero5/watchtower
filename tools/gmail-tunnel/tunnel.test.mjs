import { createVerify, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildPushConfig,
  fetchAccessToken,
  modifyPushConfig,
  parseServiceAccountKey,
  parseTunnelUrl,
  PUBSUB_SCOPE,
  readSettings,
  selfCheck,
  signAssertion,
  TOKEN_URI,
  waitForTunnel,
} from './tunnel.mjs';

// Made-up values, not credentials. The key pair is generated for the test.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const KEY = { clientEmail: 'pubsub-admin@demo-project.iam.gserviceaccount.com', privateKey: PEM };
const SETTINGS = {
  project: 'demo-project-123',
  subscription: 'gmail-push-sub',
  audience: 'watchtower-gmail-push',
  pushServiceAccount: 'push@demo-project-123.iam.gserviceaccount.com',
};
const URL_ = 'https://brave-lake-test-words.trycloudflare.com';

function recorder(responses) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    };
  };
  return { calls, fetchFn };
}

describe('parseTunnelUrl', () => {
  it('finds the quick-tunnel URL in a cloudflared log line', () => {
    const line = `2026-11-03T09:00:00Z INF |  ${URL_}                 |`;
    expect(parseTunnelUrl(line)).toBe(URL_);
  });

  it('ignores other https URLs and lookalike hosts', () => {
    expect(parseTunnelUrl('INF see https://developers.cloudflare.com/docs')).toBeNull();
    expect(parseTunnelUrl('https://evil.example/trycloudflare.com')).toBeNull();
    expect(parseTunnelUrl('http://abc.trycloudflare.com')).toBeNull();
  });
});

describe('readSettings', () => {
  const env = {
    PUBSUB_PROJECT_ID: SETTINGS.project,
    GMAIL_PUSH_AUDIENCE: SETTINGS.audience,
    GMAIL_PUSH_SERVICE_ACCOUNT: SETTINGS.pushServiceAccount,
  };

  it('defaults the subscription to gmail-push-sub', () => {
    expect(readSettings(env)).toEqual(SETTINGS);
  });

  it('names the missing setting without echoing any value', () => {
    expect(() => readSettings({ ...env, PUBSUB_PROJECT_ID: '' })).toThrow('PUBSUB_PROJECT_ID');
    expect(() => readSettings({ ...env, GMAIL_PUSH_AUDIENCE: ' ' })).toThrow('GMAIL_PUSH_AUDIENCE');
    expect(() => readSettings({ ...env, GMAIL_PUSH_SERVICE_ACCOUNT: 'nope' })).toThrow(
      /^GMAIL_PUSH_SERVICE_ACCOUNT is not an email$/,
    );
    expect(() => readSettings({ ...env, GMAIL_TUNNEL_SUBSCRIPTION: 'a/../b' })).toThrow(
      'GMAIL_TUNNEL_SUBSCRIPTION',
    );
  });
});

describe('parseServiceAccountKey', () => {
  const file = {
    type: 'service_account',
    client_email: KEY.clientEmail,
    private_key: PEM,
    token_uri: TOKEN_URI,
  };

  it('keeps only the email and the private key', () => {
    expect(parseServiceAccountKey(JSON.stringify(file))).toEqual(KEY);
  });

  it('refuses a file that is not a service account key or sends the assertion elsewhere', () => {
    expect(() => parseServiceAccountKey('not json')).toThrow('not JSON');
    expect(() =>
      parseServiceAccountKey(JSON.stringify({ ...file, type: 'authorized_user' })),
    ).toThrow();
    expect(() =>
      parseServiceAccountKey(JSON.stringify({ ...file, token_uri: 'https://evil.example/token' })),
    ).toThrow('another token endpoint');
  });
});

describe('signAssertion', () => {
  it('is an RS256 JWT for the Pub/Sub scope that verifies with the public key', () => {
    const jwt = signAssertion(KEY, 1_800_000_000);
    const [header, claims, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: KEY.clientEmail,
      scope: PUBSUB_SCOPE,
      aud: TOKEN_URI,
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });
});

describe('fetchAccessToken', () => {
  it('posts a jwt-bearer grant to Google and returns the token', async () => {
    const { calls, fetchFn } = recorder([{ status: 200, body: { access_token: 'ya29.test' } }]);
    await expect(fetchAccessToken(fetchFn, KEY, 1_800_000_000)).resolves.toBe('ya29.test');
    expect(calls[0].url).toBe(TOKEN_URI);
    const form = new URLSearchParams(calls[0].init.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(form.get('assertion')?.split('.')).toHaveLength(3);
  });

  it('reports only the status on failure', async () => {
    const { fetchFn } = recorder([{ status: 400, body: { error: 'secret detail' } }]);
    await expect(fetchAccessToken(fetchFn, KEY, 1)).rejects.toThrow(
      /^token request failed: HTTP 400$/,
    );
  });
});

describe('modifyPushConfig', () => {
  it('points the subscription at the tunnel and keeps the fixed audience', async () => {
    const { calls, fetchFn } = recorder([{ status: 200, body: {} }]);
    await modifyPushConfig(fetchFn, 'ya29.test', URL_, SETTINGS);
    expect(calls[0].url).toBe(
      'https://pubsub.googleapis.com/v1/projects/demo-project-123/subscriptions/gmail-push-sub:modifyPushConfig',
    );
    expect(calls[0].init.headers.authorization).toBe('Bearer ya29.test');
    expect(JSON.parse(calls[0].init.body)).toEqual(buildPushConfig(URL_, SETTINGS));
    expect(buildPushConfig(URL_, SETTINGS)).toEqual({
      pushConfig: {
        pushEndpoint: `${URL_}/v1/inbound/gmail/push`,
        oidcToken: {
          serviceAccountEmail: SETTINGS.pushServiceAccount,
          audience: 'watchtower-gmail-push',
        },
      },
    });
  });

  it('refuses an endpoint that is not a quick tunnel, before any request', async () => {
    const { calls, fetchFn } = recorder([]);
    await expect(
      modifyPushConfig(fetchFn, 't', 'https://evil.example', SETTINGS),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('reports only the status on failure', async () => {
    const { fetchFn } = recorder([{ status: 403, body: {} }]);
    await expect(modifyPushConfig(fetchFn, 't', URL_, SETTINGS)).rejects.toThrow(
      /^modifyPushConfig failed: HTTP 403$/,
    );
  });
});

describe('waitForTunnel and selfCheck', () => {
  it('waits until the filter answers 404 through the tunnel', async () => {
    const { calls, fetchFn } = recorder([new Error('ENOTFOUND'), { status: 530 }, { status: 404 }]);
    await expect(waitForTunnel(fetchFn, URL_, { sleep: async () => {} })).resolves.toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('gives up after the attempts', async () => {
    const { fetchFn } = recorder([{ status: 530 }, { status: 530 }]);
    await expect(
      waitForTunnel(fetchFn, URL_, { attempts: 2, sleep: async () => {} }),
    ).resolves.toBe(false);
  });

  it('posts a push with a made-up token and returns the status', async () => {
    const { calls, fetchFn } = recorder([{ status: 401 }]);
    await expect(selfCheck(fetchFn, URL_)).resolves.toBe(401);
    expect(calls[0].url).toBe(`${URL_}/v1/inbound/gmail/push`);
    expect(calls[0].init.headers.authorization).toBe('Bearer self-check.not-a-token');
  });
});
