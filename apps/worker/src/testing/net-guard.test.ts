import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';

import { NetConnectDisabledError, disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSmtpMailer } from '../mailer.js';

// Sample use of disableNetConnect (packages/shared/src/testing.ts) in a worker test, and the proof
// that it covers the clients the worker and the api use: fetch, node http/https and SMTP. Anything
// that would leave the machine fails (N1); servers on localhost (Postgres, Redis, Mailpit, the
// ones a test starts) keep working.

let guard: ReturnType<typeof disableNetConnect>;
let local: http.Server;
let port = 0;

beforeAll(async () => {
  guard = disableNetConnect();
  local = http.createServer((_request, response) => {
    response.end('local');
  });
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
  port = (local.address() as AddressInfo).port;
});

afterAll(async () => {
  guard.restore();
  await new Promise<void>((resolve) => {
    local.close(() => {
      resolve();
    });
    local.closeAllConnections();
  });
});

describe('worker tests without network access', () => {
  it('cannot send mail to a host outside this machine', async () => {
    const mailer = createSmtpMailer({
      host: 'smtp.example.com',
      port: 587,
      from: 'Watchtower <no-reply@example.com>',
      requireTls: false,
    });
    try {
      await expect(
        mailer.send({ to: 'someone@example.com', subject: 'x', text: 'x', html: '<p>x</p>' }),
      ).rejects.toThrow(/disableNetConnect/);
    } finally {
      mailer.close();
    }
    expect(guard.blocked()).toContain('dns:smtp.example.com');
  });

  it('cannot fetch a real host, over http or https', async () => {
    await expect(fetch('https://example.com/')).rejects.toThrow();
    const cause = await fetch('http://example.com/').catch((error: unknown) => error);
    expect(String((cause as Error).cause ?? cause)).toContain('disableNetConnect');
    expect(guard.blocked()).toEqual(expect.arrayContaining(['example.com:443', 'example.com:80']));
  });

  it('cannot use the node http or https clients', async () => {
    const viaHttp = await new Promise<unknown>((resolve) => {
      http.get('http://example.com/', { agent: false }, () => undefined).on('error', resolve);
    });
    expect(viaHttp).toBeInstanceOf(NetConnectDisabledError);
    const viaHttps = await new Promise<unknown>((resolve) => {
      https.get('https://example.com/', { agent: false }, () => undefined).on('error', resolve);
    });
    expect(viaHttps).toMatchObject({ code: 'ERR_NET_CONNECT_DISABLED', host: 'example.com' });
  });

  it('still reaches a server on this machine', async () => {
    const before = guard.blocked().length;
    expect(await (await fetch(`http://127.0.0.1:${String(port)}/`)).text()).toBe('local');
    expect(await (await fetch(`http://localhost:${String(port)}/`)).text()).toBe('local');
    expect(guard.blocked()).toHaveLength(before);
  });
});
