import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createLimiter,
  createPushFilter,
  MAX_BODY_BYTES,
  PER_CLIENT_PER_MINUTE,
  PUSH_PATH,
  TOTAL_PER_MINUTE,
} from './filter.mjs';

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

function listen(server) {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/** A fake api that records what reached it. */
async function fakeApi() {
  const seen = [];
  const port = await listen(
    createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body });
        res.writeHead(204, {
          'content-type': 'text/plain',
          'set-cookie': 'leak=1',
          'x-internal': 'yes',
        });
        res.end();
      });
    }),
  );
  return { seen, upstream: new URL(`http://127.0.0.1:${String(port)}`) };
}

async function filterFor(upstream, limit, totalLimit) {
  const port = await listen(
    createPushFilter({
      upstream,
      ...(limit ? { limit } : {}),
      ...(totalLimit ? { totalLimit } : {}),
    }),
  );
  return `http://127.0.0.1:${String(port)}`;
}

const SIGNED = { authorization: 'Bearer test.jwt.value', 'content-type': 'application/json' };

describe('push-only filter', () => {
  it('refuses an upstream that is not loopback or the compose api', () => {
    expect(() => createPushFilter({ upstream: new URL('http://evil.example') })).toThrow();
  });

  it('forwards only a signed POST to the push path, without query or extra headers', async () => {
    const api = await fakeApi();
    const base = await filterFor(api.upstream);
    const res = await fetch(`${base}${PUSH_PATH}?x=1`, {
      method: 'POST',
      headers: { ...SIGNED, 'x-forwarded-for': '1.2.3.4', cookie: 'a=b', 'x-real-ip': '5.6.7.8' },
      body: '{"message":{}}',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-internal')).toBeNull();
    expect(api.seen).toHaveLength(1);
    expect(api.seen[0].url).toBe(PUSH_PATH);
    expect(api.seen[0].body).toBe('{"message":{}}');
    expect(api.seen[0].headers.authorization).toBe(SIGNED.authorization);
    for (const name of ['x-forwarded-for', 'cookie', 'x-real-ip']) {
      expect(api.seen[0].headers[name]).toBeUndefined();
    }
  });

  it('answers other paths and methods itself', async () => {
    const api = await fakeApi();
    const base = await filterFor(api.upstream);
    for (const [method, path] of [
      ['GET', PUSH_PATH],
      ['POST', '/v1/auth/dev-login'],
      ['POST', '/v1/inbound/gmail/push/'],
      ['POST', '/v1/inbound/gmail%2Fpush'],
      ['POST', '//v1/inbound/gmail/push'],
    ]) {
      const res = await fetch(`${base}${path}`, { method, headers: SIGNED });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(api.seen).toHaveLength(0);
  });

  it('answers an unsigned push with 401 without reaching the api', async () => {
    const api = await fakeApi();
    const base = await filterFor(api.upstream);
    const res = await fetch(`${base}${PUSH_PATH}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(api.seen).toHaveLength(0);
  });

  it('refuses a body over the cap', async () => {
    const api = await fakeApi();
    const base = await filterFor(api.upstream);
    const res = await fetch(`${base}${PUSH_PATH}`, {
      method: 'POST',
      headers: SIGNED,
      body: 'x'.repeat(MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(api.seen).toHaveLength(0);
  });

  it('limits each client separately by cf-connecting-ip', async () => {
    const api = await fakeApi();
    const base = await filterFor(api.upstream, 2);
    const send = (ip) =>
      fetch(`${base}${PUSH_PATH}`, {
        method: 'POST',
        headers: { ...SIGNED, 'cf-connecting-ip': ip },
        body: '{}',
      }).then((r) => r.status);
    expect([
      await send('203.0.113.9'),
      await send('203.0.113.9'),
      await send('203.0.113.9'),
    ]).toEqual([204, 204, 429]);
    expect(await send('198.51.100.7')).toBe(204);
  });

  it('caps the total that reaches the api, so many callers cannot fill its one bucket (T-114a C-7)', async () => {
    const api = await fakeApi();
    const base = await filterFor(api.upstream, 10, 3);
    const send = (ip, headers = SIGNED) =>
      fetch(`${base}${PUSH_PATH}`, {
        method: 'POST',
        headers: { ...headers, 'cf-connecting-ip': ip },
        body: '{}',
      }).then((r) => r.status);
    expect([
      await send('203.0.113.1'),
      await send('203.0.113.2'),
      await send('203.0.113.3'),
      await send('203.0.113.4'),
    ]).toEqual([204, 204, 204, 429]);
    expect(api.seen).toHaveLength(3);
    // An unsigned request never reaches the api, so it does not use up the total either.
    expect(await send('203.0.113.5', { 'content-type': 'application/json' })).toBe(401);
  });

  it('keeps the total below the api limit (600 per minute by default)', () => {
    expect(TOTAL_PER_MINUTE).toBeLessThan(600);
    expect(PER_CLIENT_PER_MINUTE).toBeLessThanOrEqual(TOTAL_PER_MINUTE);
  });
});

describe('createLimiter', () => {
  it('starts a new window each minute', () => {
    let now = 0;
    const allow = createLimiter(1, () => now);
    expect([allow('a'), allow('a')]).toEqual([true, false]);
    now = 60_000;
    expect(allow('a')).toBe(true);
  });
});
