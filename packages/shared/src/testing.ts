import dns from 'node:dns';
import net from 'node:net';

/**
 * Test support, imported as `@watchtower/shared/testing` (not from the package root, so production
 * code never pulls it in).
 *
 * `disableNetConnect()` makes every outbound TCP connection to a non-loopback address fail with a
 * `NetConnectDisabledError`, so a test that would reach Gmail, LINE, Discord, GCP, an LLM provider
 * or any other real service fails loudly instead of leaving the machine (N1, N2, PRD section 8.2,
 * and the "mock mode never touches the network" checks of T-113). Connections to this machine
 * (`localhost`, `127.0.0.0/8`, `::1`, unix sockets) still work, so Postgres, Redis, MinIO, Mailpit
 * and servers a test starts itself are unaffected.
 *
 * Usage, in any api / worker / package test file:
 *
 * ```ts
 * import { disableNetConnect } from '@watchtower/shared/testing';
 *
 * const net = disableNetConnect();           // beforeAll, or at the top of the file
 * afterAll(() => net.restore());
 * // ... the code under test runs; if it dials out it gets a rejected promise / 'error' event
 * expect(net.blocked()).toEqual([]);          // proves nothing even tried
 * ```
 *
 * How: it replaces `net.Socket.prototype.connect`. Node's `http`, `https`, `tls`, the built-in
 * `fetch` (undici), `pg`, `ioredis` and nodemailer all open sockets through it, and it sees the
 * host name before any DNS lookup. Libraries that resolve a name themselves first (nodemailer
 * calls `dns.resolve4`) would still send a DNS query, so the `dns` functions that take a host name
 * (`lookup`, `resolve*`, callback and `dns.promises` forms) are guarded the same way. A refusal is
 * delivered asynchronously, as an `error` on the socket or a callback error or a rejected promise
 * (never a synchronous throw), which is how a real network failure looks to callers.
 *
 * Limits `[TESTED]` for tcp / tls / fetch / http / smtp: it does not cover UDP (`dgram`), a
 * `dns.Resolver` instance, spawned child processes, native addons that open their own sockets, or
 * a socket given an already-connected handle. Use `allowHosts` for a service that is deliberately
 * reached by name inside a test (for example a compose service name).
 */

export class NetConnectDisabledError extends Error {
  readonly code = 'ERR_NET_CONNECT_DISABLED';
  readonly host: string;
  readonly port: number | undefined;

  constructor(host: string, port: number | undefined) {
    super(
      `Outbound network connection to ${host}${port === undefined ? '' : `:${String(port)}`} was blocked by disableNetConnect()`,
    );
    this.name = 'NetConnectDisabledError';
    this.host = host;
    this.port = port;
  }
}

export interface NetGuardOptions {
  /** Extra host names (lower-case, exact match) that may be reached. Loopback is always allowed. */
  readonly allowHosts?: readonly string[];
}

export interface NetGuard {
  /** Puts the original `connect` back. Safe to call twice. */
  restore(): void;
  /** `host:port` of every connection that was refused since `disableNetConnect()` was called. */
  blocked(): readonly string[];
}

/** True for localhost, `*.localhost`, 127.0.0.0/8, ::1 and the IPv4-mapped loopback. */
export function isLoopbackHost(value: string): boolean {
  let host = value.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.startsWith('::ffff:')) host = host.slice('::ffff:'.length);
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

interface Target {
  /** Unix socket / named pipe: always local. */
  readonly local: boolean;
  readonly host: string;
  readonly port: number | undefined;
}

type ConnectFn = (this: net.Socket, ...args: unknown[]) => net.Socket;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the host and port out of the several argument shapes `Socket.prototype.connect` takes. */
function targetOf(args: readonly unknown[]): Target {
  let first = args[0];
  // net passes an already normalized `[options, callback]` array between its own layers.
  if (Array.isArray(first)) first = (first as unknown[])[0];

  if (isRecord(first)) {
    if (typeof first.path === 'string') return { local: true, host: first.path, port: undefined };
    const host = typeof first.host === 'string' && first.host !== '' ? first.host : 'localhost';
    const port = typeof first.port === 'number' ? first.port : Number(first.port);
    return { local: false, host, port: Number.isFinite(port) ? port : undefined };
  }
  // connect(path[, cb])
  if (typeof first === 'string' && Number.isNaN(Number(first))) {
    return { local: true, host: first, port: undefined };
  }
  // connect(port[, host][, cb])
  const port = Number(first);
  const host = typeof args[1] === 'string' && args[1] !== '' ? args[1] : 'localhost';
  return { local: false, host, port: Number.isFinite(port) ? port : undefined };
}

/** The `dns` functions whose first argument is a host name. */
const DNS_FUNCTIONS = [
  'lookup',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCname',
  'resolveMx',
  'resolveNs',
  'resolveSrv',
  'resolveTxt',
] as const;

type DnsFunction = (this: unknown, ...args: unknown[]) => unknown;
type DnsModule = Record<string, DnsFunction | undefined>;

/** Guards the `dns` and `dns.promises` functions; returns the function that puts them back. */
function guardDns(permits: (host: string) => boolean, refuse: (host: string) => Error): () => void {
  const restores: (() => void)[] = [];
  const modules: readonly { readonly module: DnsModule; readonly promise: boolean }[] = [
    { module: dns as unknown as DnsModule, promise: false },
    { module: dns.promises as unknown as DnsModule, promise: true },
  ];
  for (const { module, promise } of modules) {
    for (const name of DNS_FUNCTIONS) {
      const original = module[name];
      if (typeof original !== 'function') continue;
      const guarded: DnsFunction = function (this: unknown, ...args: unknown[]): unknown {
        const host = args[0];
        // An IP literal needs no lookup; connecting to it is the connect guard's business.
        if (typeof host !== 'string' || net.isIP(host) !== 0 || permits(host)) {
          return original.apply(this, args);
        }
        const error = refuse(host);
        if (promise) return Promise.reject(error);
        const callback = args.at(-1);
        if (typeof callback === 'function') {
          process.nextTick(callback, error);
        }
        return undefined;
      };
      module[name] = guarded;
      restores.push(() => {
        if (module[name] === guarded) module[name] = original;
      });
    }
  }
  return () => {
    for (const restore of restores) restore();
  };
}

export function disableNetConnect(options: NetGuardOptions = {}): NetGuard {
  const allowed = new Set((options.allowHosts ?? []).map((host) => host.toLowerCase()));
  const permits = (host: string): boolean =>
    isLoopbackHost(host) || allowed.has(host.toLowerCase());
  const proto = net.Socket.prototype as unknown as { connect: ConnectFn };
  const original = proto.connect;
  const blocked: string[] = [];

  const guarded: ConnectFn = function (this: net.Socket, ...args: unknown[]): net.Socket {
    const target = targetOf(args);
    if (target.local || permits(target.host)) {
      return original.apply(this, args);
    }
    blocked.push(`${target.host}${target.port === undefined ? '' : `:${String(target.port)}`}`);
    const error = new NetConnectDisabledError(target.host, target.port);
    // Like a real failed connection: an 'error' event after the call returns, then closed.
    process.nextTick(() => {
      this.destroy(error);
    });
    return this;
  };
  proto.connect = guarded;
  const restoreDns = guardDns(permits, (host) => {
    blocked.push(`dns:${host}`);
    return new NetConnectDisabledError(host, undefined);
  });

  return {
    restore() {
      if (proto.connect === guarded) proto.connect = original;
      restoreDns();
    },
    blocked: () => [...blocked],
  };
}
