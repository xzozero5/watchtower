import { createHash } from 'node:crypto';

/**
 * Deterministic randomness for the one-year scenario: the same seed gives the same dataset on every
 * run and every machine (mulberry32 over a 32-bit state; no Math.random, no clock).
 */
export class Rng {
  private state: number;

  constructor(seed: number | string) {
    this.state =
      typeof seed === 'number'
        ? seed >>> 0
        : createHash('sha256').update(seed).digest().readUInt32LE(0);
  }

  /** A child generator whose stream does not depend on how much the parent has consumed. */
  fork(label: string): Rng {
    return new Rng(`${String(this.state)}:${label}`);
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('pick from an empty list');
    return item;
  }

  /** Picks by weight; `weights` are relative. */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [item, weight] of items) {
      roll -= weight;
      if (roll < 0) return item;
    }
    const last = items[items.length - 1];
    if (!last) throw new Error('weighted pick from an empty list');
    return last[0];
  }

  /** Standard normal (Box-Muller). */
  normal(): number {
    const u = Math.max(this.next(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }

  /** Log-normal with the given median and sigma. */
  logNormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }

  /** Poisson-ish count with the given mean (normal approximation, never below zero). */
  count(mean: number): number {
    if (mean <= 0) return 0;
    if (mean < 12) {
      const limit = Math.exp(-mean);
      let product = 1;
      let k = 0;
      do {
        k += 1;
        product *= this.next();
      } while (product > limit);
      return k - 1;
    }
    return Math.max(0, Math.round(mean + Math.sqrt(mean) * this.normal()));
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const other = Math.floor(this.next() * (index + 1));
      const a = copy[index] as T;
      copy[index] = copy[other] as T;
      copy[other] = a;
    }
    return copy;
  }

  /** A v4-shaped UUID drawn from this stream (so ids repeat across runs). */
  uuid(): string {
    const hex = Array.from({ length: 32 }, () => this.int(0, 15).toString(16)).join('');
    return (
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
      `${'89ab'[this.int(0, 3)] ?? '8'}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    );
  }

  hex(length: number): string {
    return Array.from({ length }, () => this.int(0, 15).toString(16)).join('');
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** Asia/Bangkok is UTC+7 all year (no DST). */
export const BANGKOK_OFFSET_MS = 7 * HOUR;

export interface LocalParts {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number; // 0 = Sunday
  readonly dateKey: string; // YYYY-MM-DD
}

export function localParts(at: Date): LocalParts {
  const shifted = new Date(at.getTime() + BANGKOK_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  return {
    year,
    month,
    day,
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
    dateKey: `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/** The instant of a Bangkok wall-clock time. */
export function bangkokTime(dateKey: string, hour: number, minute = 0): Date {
  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, hour, minute) - BANGKOK_OFFSET_MS);
}

export function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
