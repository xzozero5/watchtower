import { lookup as dnsLookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

import type { webpush } from '@watchtower/channels';
import { isBlockedAddress } from '@watchtower/channels';

/** What a push service answered. The body is never read: a push service has nothing we need in it. */
export interface PushResponse {
  readonly status: number;
  /** The `Retry-After` header, as sent. */
  readonly retryAfter: string | undefined;
}

/** Sends one prepared request. Throws `PushTransportError` when no answer came. */
export type PushTransport = (request: webpush.PushRequest) => Promise<PushResponse>;

export type PushTransportFailure = 'blocked_address' | 'dns' | 'timeout' | 'network';

export class PushTransportError extends Error {
  constructor(readonly reason: PushTransportFailure) {
    super(`push transport failed: ${reason}`);
    this.name = 'PushTransportError';
  }
}

export interface HttpsTransportOptions {
  /** Whole request, connect to last byte of the answer. */
  readonly timeoutMs?: number;
  /** Resolves a host name to every address it has. Default: the system resolver. Tests pass a fake. */
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
  /** Test seam: `http.request`, to talk to a plain local fake server. Production uses `https.request`. */
  readonly request?: typeof https.request;
  /**
   * Test seam: where to really connect once an address passed the check (a local fake server stands in
   * for a "public" address). Never set in production.
   */
  readonly dial?: (
    address: string,
    port: number,
  ) => { readonly address: string; readonly port: number };
}

async function systemResolve(hostname: string): Promise<readonly string[]> {
  const found = await dnsLookup(hostname, { all: true, order: 'verbatim' });
  return found.map((entry) => entry.address);
}

/**
 * The live transport: an HTTPS POST to a push service, with the same discipline as the image proxy
 * (apps/api/src/egress/safe-fetch.ts): the host name is resolved here, every address must be public
 * (a push service never resolves to a private address, so a poisoned or rebinding answer is refused),
 * and the connection goes to the address that was checked. No redirect is followed (a push service does
 * not redirect a POST; a 3xx is just "rejected"), no proxy (`agent: false` with an own `lookup`), no
 * cookies. The endpoint was already matched against the push-service allow-list by `buildPushRequest`.
 */
export function createHttpsPushTransport(options: HttpsTransportOptions = {}): PushTransport {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const resolve = options.resolve ?? systemResolve;

  return async (request) => {
    const host = request.url.hostname;
    let addresses: readonly string[];
    if (isIP(host) !== 0) {
      addresses = [host];
    } else {
      try {
        addresses = await resolve(host);
      } catch {
        throw new PushTransportError('dns');
      }
    }
    const first = addresses[0];
    if (first === undefined) throw new PushTransportError('dns');
    if (addresses.some((address) => isBlockedAddress(address))) {
      throw new PushTransportError('blocked_address');
    }
    const port = request.url.port === '' ? 443 : Number(request.url.port);
    const target = options.dial?.(first, port) ?? { address: first, port };
    const family = isIP(target.address) === 6 ? 6 : 4;

    return new Promise<PushResponse>((resolveResponse, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const outgoing = (options.request ?? https.request)({
        hostname: host,
        port: target.port,
        path: `${request.url.pathname}${request.url.search}`,
        method: 'POST',
        agent: false,
        // The connection goes to the checked address, whatever DNS would say now.
        lookup: (_name, lookupOptions, callback) => {
          if (lookupOptions.all === true) {
            callback(null, [{ address: target.address, family }]);
          } else {
            (callback as (error: null, address: string, family: number) => void)(
              null,
              target.address,
              family,
            );
          }
        },
        servername: host,
        headers: { ...request.headers, Connection: 'close' },
      });
      const timer = setTimeout(() => {
        outgoing.destroy();
        finish(() => {
          reject(new PushTransportError('timeout'));
        });
      }, timeoutMs);
      outgoing.on('error', () => {
        finish(() => {
          reject(new PushTransportError('network'));
        });
      });
      outgoing.on('response', (incoming: IncomingMessage) => {
        const retryAfter = incoming.headers['retry-after'];
        const status = incoming.statusCode ?? 0;
        incoming.resume();
        incoming.on('end', () => {
          finish(() => {
            resolveResponse({
              status,
              retryAfter,
            });
          });
        });
        incoming.on('error', () => {
          finish(() => {
            reject(new PushTransportError('network'));
          });
        });
      });
      outgoing.end(request.body);
    });
  };
}
