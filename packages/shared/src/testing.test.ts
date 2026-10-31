import dns from 'node:dns';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { NetConnectDisabledError, disableNetConnect, isLoopbackHost } from './testing.js';

// This package may not know about HTTP (docs/04-ARCHITECTURE.md section 3), so the tests here use
// raw TCP and dns. The http / https / fetch / SMTP behavior is proven in apps/worker
// (testing/net-guard.test.ts).

let server: net.Server;
let port = 0;

beforeAll(async () => {
  server = net.createServer((socket) => {
    socket.end('local');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
});

let guard: ReturnType<typeof disableNetConnect> | undefined;
afterEach(() => {
  guard?.restore();
  guard = undefined;
});

const read = (socket: net.Socket) =>
  new Promise<string>((resolve, reject) => {
    let text = '';
    socket.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    socket.on('end', () => {
      resolve(text);
    });
    socket.on('error', reject);
  });

const failure = (socket: net.Socket) =>
  new Promise<unknown>((resolve) => {
    socket.on('error', resolve);
  });

describe('isLoopbackHost', () => {
  it.each([
    'localhost',
    'api.localhost',
    '127.0.0.1',
    '127.9.9.9',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
  ])('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    'example.com',
    '10.0.0.5',
    '192.168.1.1',
    '169.254.169.254',
    '8.8.8.8',
    '127.0.0.1.example.com',
  ])('refuses %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('disableNetConnect', () => {
  it('refuses a connection by address or by name, in both call styles, and records it', async () => {
    guard = disableNetConnect();
    const byOptions = await failure(net.connect({ host: '169.254.169.254', port: 80 }));
    expect(byOptions).toBeInstanceOf(NetConnectDisabledError);
    expect(byOptions).toMatchObject({ code: 'ERR_NET_CONNECT_DISABLED', port: 80 });
    expect(await failure(net.connect(5432, '10.0.0.5'))).toBeInstanceOf(NetConnectDisabledError);
    // A name is refused before any DNS lookup could leave the machine.
    const byName = await failure(net.connect({ host: 'smtp.example.com', port: 587 }));
    expect(byName).toBeInstanceOf(NetConnectDisabledError);
    expect(guard.blocked()).toEqual([
      '169.254.169.254:80',
      '10.0.0.5:5432',
      'smtp.example.com:587',
    ]);
  });

  it('refuses a DNS lookup of a real name, in callback and promise form', async () => {
    guard = disableNetConnect();
    const viaCallback = await new Promise<unknown>((resolve) => {
      dns.resolve4('smtp.example.com', (error) => {
        resolve(error);
      });
    });
    expect(viaCallback).toBeInstanceOf(NetConnectDisabledError);
    await expect(dns.promises.lookup('example.com')).rejects.toBeInstanceOf(
      NetConnectDisabledError,
    );
    expect(guard.blocked()).toEqual(['dns:smtp.example.com', 'dns:example.com']);
    // Names that stay on this machine still resolve.
    expect((await dns.promises.lookup('localhost')).address).toMatch(/^(127\.|::1)/);
  });

  it('still reaches this machine: loopback by address and by name', async () => {
    guard = disableNetConnect();
    expect(await read(net.connect({ host: '127.0.0.1', port }))).toBe('local');
    expect(await read(net.connect({ host: 'localhost', port }))).toBe('local');
    expect(await read(net.connect(port))).toBe('local');
    expect(guard.blocked()).toEqual([]);
  });

  it('lets a test allow one named host', async () => {
    guard = disableNetConnect({ allowHosts: ['compose-service'] });
    // A custom lookup resolves the name to this machine, so nothing touches real DNS.
    const lookup: net.LookupFunction = (_host, options, callback) => {
      if (options.all === true) {
        (callback as unknown as (error: null, addresses: object[]) => void)(null, [
          { address: '127.0.0.1', family: 4 },
        ]);
      } else {
        callback(null, '127.0.0.1', 4);
      }
    };
    expect(await read(net.connect({ host: 'compose-service', port, lookup }))).toBe('local');
    expect(guard.blocked()).toEqual([]);

    // The same name without the allowance is refused.
    guard.restore();
    guard = disableNetConnect();
    expect(await failure(net.connect({ host: 'compose-service', port, lookup }))).toBeInstanceOf(
      NetConnectDisabledError,
    );
  });

  it('puts the original behavior back on restore, and restore twice is harmless', async () => {
    const installed = disableNetConnect();
    expect(await failure(net.connect({ host: 'example.com', port: 80 }))).toBeInstanceOf(
      NetConnectDisabledError,
    );
    installed.restore();
    installed.restore();
    expect(await read(net.connect({ host: '127.0.0.1', port }))).toBe('local');
    expect((await dns.promises.lookup('localhost')).address).toMatch(/^(127\.|::1)/);
  });
});
