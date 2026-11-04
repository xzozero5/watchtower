import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';

import { isBlockedAddress, isInternalHostname } from './ip-guard.js';

/**
 * Why a fetch for a user-supplied URL was refused or failed. The caller turns every one of these into the
 * same generic answer (what the target said, or that it resolved to an internal address, is information
 * about our network and is not handed to the person who supplied the URL); the reason goes to the audit log.
 */
export type EgressReason =
  | 'bad_url'
  | 'scheme'
  | 'credentials'
  | 'port'
  | 'blocked_host'
  | 'blocked_address'
  | 'dns'
  | 'redirects'
  | 'status'
  | 'timeout'
  | 'too_large'
  | 'not_image'
  | 'network';

export class EgressError extends Error {
  constructor(readonly reason: EgressReason) {
    super(`egress refused: ${reason}`);
    this.name = 'EgressError';
  }
}

export type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface FetchedImage {
  readonly bytes: Buffer;
  /** From the bytes, never from the server's header. */
  readonly contentType: ImageType;
}

export interface SafeFetchOptions {
  /** `http:` is refused unless this is true (REMOTE_IMAGES_ALLOW_HTTP). */
  readonly allowHttp: boolean;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  /** Whole fetch, redirects included. */
  readonly timeoutMs?: number;
  readonly userAgent?: string;
  /** Ports a request may go to. Default 80 and 443; `'any'` is for tests with a local fake server. */
  readonly allowedPorts?: 'any' | readonly number[];
  /** Resolves a host name to every address it has. Default: the system resolver. Tests pass a fake. */
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
  /**
   * Test seam: where to actually connect once an address passed the checks (a fake server stands in for
   * a "public" address the fake resolver returned). Never set in production.
   */
  readonly dial?: (
    address: string,
    port: number,
  ) => { readonly address: string; readonly port: number };
}

const DEFAULTS = {
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 3,
  timeoutMs: 10_000,
  userAgent: 'Watchtower-ImageProxy/1.0',
} as const;

async function systemResolve(hostname: string): Promise<readonly string[]> {
  const found: LookupAddress[] = await dnsLookup(hostname, { all: true, order: 'verbatim' });
  return found.map((entry) => entry.address);
}

/** The image type the first bytes say it is; null for anything else (SVG, HTML and so on are never images here). */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const at = (offset: number, ...expected: number[]): boolean =>
    expected.every((value, index) => bytes[offset + index] === value);
  if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return 'image/png';
  if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (
    bytes.length >= 6 &&
    (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))
  ) {
    return 'image/gif';
  }
  if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) {
    return 'image/webp';
  }
  return null;
}

interface Response {
  readonly status: number;
  readonly location: string | null;
  readonly contentType: string;
  readonly contentLength: number | null;
  readonly body: Buffer | null;
}

/**
 * Fetches one image from a URL somebody else chose (a remote image in a customer's mail) without letting
 * that person reach our network (T-175):
 *
 * - https only (http when `allowHttp`), no credentials in the URL, port 80/443 only;
 * - the host name is resolved here, every address must be public, and the connection is made to that
 *   checked address (the socket's `lookup` returns it), so a second DNS answer cannot swap in a private one
 *   (DNS rebinding); the same is done for each redirect, which is followed by us, at most `maxRedirects` times;
 * - a literal IP in the URL is checked the same way, `localhost`/`.local`/`.internal` names are refused outright;
 * - no cookies, no `Authorization`, no `Referer`, a fixed User-Agent, `Accept-Encoding: identity`;
 * - one deadline for the whole fetch, at most `maxBytes` of body, `Content-Type: image/*` and the first bytes
 *   must be PNG, JPEG, GIF or WebP (SVG is refused: it can carry script).
 */
export class SafeImageFetcher {
  private readonly options: Required<
    Pick<SafeFetchOptions, 'maxBytes' | 'maxRedirects' | 'timeoutMs' | 'userAgent'>
  > &
    SafeFetchOptions;

  constructor(options: SafeFetchOptions) {
    this.options = { ...DEFAULTS, ...options };
  }

  async fetchImage(rawUrl: string): Promise<FetchedImage> {
    const deadline = AbortSignal.timeout(this.options.timeoutMs);
    let current = rawUrl;
    for (let hop = 0; hop <= this.options.maxRedirects; hop += 1) {
      const url = this.parse(current);
      const address = await this.checkedAddress(url, deadline);
      const response = await this.request(url, address, deadline);
      if (
        response.status >= 300 &&
        response.status < 400 &&
        [301, 302, 303, 307, 308].includes(response.status)
      ) {
        if (response.location === null || response.location === '') throw new EgressError('status');
        try {
          current = new URL(response.location, url).toString();
        } catch {
          throw new EgressError('bad_url');
        }
        continue;
      }
      if (response.status !== 200 || response.body === null) throw new EgressError('status');
      if (!/^image\//i.test(response.contentType) || /svg/i.test(response.contentType)) {
        throw new EgressError('not_image');
      }
      const type = sniffImage(response.body);
      if (type === null) throw new EgressError('not_image');
      return { bytes: response.body, contentType: type };
    }
    throw new EgressError('redirects');
  }

  private parse(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new EgressError('bad_url');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && this.options.allowHttp)) {
      throw new EgressError('scheme');
    }
    if (url.username !== '' || url.password !== '') throw new EgressError('credentials');
    const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
    const allowed = this.options.allowedPorts ?? [80, 443];
    if (allowed !== 'any' && !allowed.includes(port)) throw new EgressError('port');
    if (isInternalHostname(url.hostname)) throw new EgressError('blocked_host');
    return url;
  }

  /** Resolves the host and returns the one address the connection will use, after every address passed. */
  private async checkedAddress(url: URL, deadline: AbortSignal): Promise<string> {
    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    if (isIP(host) !== 0) {
      if (isBlockedAddress(host)) throw new EgressError('blocked_address');
      return host;
    }
    const resolve = this.options.resolve ?? systemResolve;
    let addresses: readonly string[];
    try {
      addresses = await Promise.race([
        resolve(host),
        new Promise<never>((_resolve, reject) => {
          deadline.addEventListener('abort', () => {
            reject(new EgressError('timeout'));
          });
        }),
      ]);
    } catch (error) {
      if (error instanceof EgressError) throw error;
      throw new EgressError('dns');
    }
    const first = addresses[0];
    if (first === undefined) throw new EgressError('dns');
    // Every answer must be public, not just the one we use: a mixed answer is a sign of an attack.
    if (addresses.some((address) => isBlockedAddress(address))) {
      throw new EgressError('blocked_address');
    }
    return first;
  }

  private request(url: URL, address: string, deadline: AbortSignal): Promise<Response> {
    const secure = url.protocol === 'https:';
    const port = url.port === '' ? (secure ? 443 : 80) : Number(url.port);
    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    const target = this.options.dial?.(address, port) ?? { address, port };
    const family = isIP(target.address) === 6 ? 6 : 4;
    const { maxBytes } = this.options;

    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const done = (action: () => void): void => {
        if (settled) return;
        settled = true;
        deadline.removeEventListener('abort', onAbort);
        action();
      };
      const request = (secure ? https : http).request({
        protocol: url.protocol,
        hostname: host,
        port: target.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        // The connection goes to the address that was checked, whatever DNS would say now.
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
        ...(secure ? { servername: isIP(host) === 0 ? host : undefined } : {}),
        headers: {
          'User-Agent': this.options.userAgent,
          Accept: 'image/png,image/jpeg,image/gif,image/webp,image/*;q=0.5',
          'Accept-Encoding': 'identity',
          Connection: 'close',
        },
      });
      const onAbort = (): void => {
        request.destroy();
        done(() => {
          reject(new EgressError('timeout'));
        });
      };
      if (deadline.aborted) {
        onAbort();
        return;
      }
      deadline.addEventListener('abort', onAbort);

      request.on('error', () => {
        done(() => {
          reject(new EgressError('network'));
        });
      });
      request.on('response', (incoming) => {
        const status = incoming.statusCode ?? 0;
        const header = (name: string): string => {
          const value = incoming.headers[name];
          return (Array.isArray(value) ? value[0] : value) ?? '';
        };
        const meta = {
          status,
          location: header('location') === '' ? null : header('location'),
          contentType: header('content-type'),
          contentLength: header('content-length') === '' ? null : Number(header('content-length')),
        };
        if (status !== 200) {
          done(() => {
            resolve({ ...meta, body: null });
          });
          incoming.destroy();
          return;
        }
        if (meta.contentLength !== null && meta.contentLength > maxBytes) {
          done(() => {
            reject(new EgressError('too_large'));
          });
          incoming.destroy();
          return;
        }
        if (!/^image\//i.test(meta.contentType) || /svg/i.test(meta.contentType)) {
          done(() => {
            reject(new EgressError('not_image'));
          });
          incoming.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        incoming.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            done(() => {
              reject(new EgressError('too_large'));
            });
            incoming.destroy();
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          done(() => {
            resolve({ ...meta, body: Buffer.concat(chunks) });
          });
        });
        incoming.on('error', () => {
          done(() => {
            reject(new EgressError('network'));
          });
        });
        incoming.on('aborted', () => {
          done(() => {
            reject(new EgressError('network'));
          });
        });
      });
      request.end();
    });
  }
}
