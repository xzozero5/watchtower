import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { ApiHttpError } from '../auth/http-errors.js';
import { EgressError, type FetchedImage } from '../egress/safe-fetch.js';

export const REMOTE_IMAGE_FETCHER = Symbol('REMOTE_IMAGE_FETCHER');

/** What the proxy needs from the egress layer; the real one is `SafeImageFetcher`, tests pass a fake. */
export interface ImageFetcher {
  fetchImage(url: string): Promise<FetchedImage>;
}

/** Settings of the proxy; the numbers are `[ASSUMED]` defaults. */
export interface RemoteImageLimits {
  readonly cacheTtlMs: number;
  readonly cacheMaxBytes: number;
  /** Fetches running at once on this instance; more get 429 so a burst cannot tie up sockets. */
  readonly maxConcurrent: number;
}
export const REMOTE_IMAGE_LIMITS = Symbol('REMOTE_IMAGE_LIMITS');
export const DEFAULT_REMOTE_IMAGE_LIMITS: RemoteImageLimits = {
  cacheTtlMs: 10 * 60 * 1000,
  cacheMaxBytes: 32 * 1024 * 1024,
  maxConcurrent: 8,
};

/** Undoes the channel sanitiser's `escapeAttribute`; `&amp;` last so `&amp;lt;` stays `&lt;`. */
function unescapeAttribute(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * The remote pictures of one stored mail, in document order: the `data-remote-src` of every `<img>` in
 * the sanitised HTML the channel adapter kept (`keepRemoteImages`). The browser sends only the position;
 * the address comes from here, so the proxy never fetches a URL the client chose.
 *
 * The HTML is the sanitiser's output, where text has `<` escaped, so `<img` can only be a real tag.
 */
export function remoteImageUrls(bodyHtml: string | null): string[] {
  if (bodyHtml === null) return [];
  const urls: string[] = [];
  for (const tag of bodyHtml.matchAll(/<img\b[^>]*>/gi)) {
    const value = /\sdata-remote-src="([^"]*)"/i.exec(tag[0]);
    if (value?.[1] !== undefined) urls.push(unescapeAttribute(value[1]));
  }
  return urls;
}

/** The host (and nothing else) for the audit log: the path and query can carry a personal token. */
export function auditHostOf(url: string): string | null {
  try {
    return new URL(url).hostname.slice(0, 253);
  } catch {
    return null;
  }
}

/** A short fingerprint of the address, to tell two pictures of one host apart in the audit log. */
export function urlFingerprint(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 12);
}

interface CacheEntry {
  readonly image: FetchedImage;
  readonly expires: number;
}

/**
 * Fetches a remote image for the reader (T-175) and keeps it in memory for a few minutes, so a message
 * with many pictures that is opened twice asks the sender's server once. The cache is per instance and
 * holds public pictures only; who may ask for one is decided before this is reached.
 */
@Injectable()
export class RemoteImageService {
  private readonly cache = new Map<string, CacheEntry>();
  private cached = 0;
  private running = 0;

  constructor(
    @Inject(REMOTE_IMAGE_FETCHER) private readonly fetcher: ImageFetcher,
    @Inject(REMOTE_IMAGE_LIMITS) private readonly limits: RemoteImageLimits,
  ) {}

  async load(url: string): Promise<{ image: FetchedImage; fromCache: boolean }> {
    const key = createHash('sha256').update(url).digest('hex');
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      if (hit.expires > now) return { image: hit.image, fromCache: true };
      this.drop(key, hit);
    }
    if (this.running >= this.limits.maxConcurrent) {
      throw new ApiHttpError(
        429,
        'rate_limited',
        'Too many pictures are loading; try again in a moment',
      );
    }
    this.running += 1;
    try {
      const image = await this.fetcher.fetchImage(url);
      this.remember(key, image, now);
      return { image, fromCache: false };
    } finally {
      this.running -= 1;
    }
  }

  private remember(key: string, image: FetchedImage, now: number): void {
    if (image.bytes.length > this.limits.cacheMaxBytes) return;
    for (const [oldKey, entry] of this.cache) {
      if (entry.expires <= now) this.drop(oldKey, entry);
    }
    for (const [oldKey, entry] of this.cache) {
      if (this.cached + image.bytes.length <= this.limits.cacheMaxBytes) break;
      this.drop(oldKey, entry); // oldest first: a Map iterates in insertion order
    }
    this.cache.set(key, { image, expires: now + this.limits.cacheTtlMs });
    this.cached += image.bytes.length;
  }

  private drop(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cached -= entry.image.bytes.length;
  }
}

/** The reason code the audit log gets for a failure of the proxy. */
export function failureReason(error: unknown): string {
  if (error instanceof EgressError) return error.reason;
  if (error instanceof ApiHttpError) return error.code;
  return 'unexpected';
}
