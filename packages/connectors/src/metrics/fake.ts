import { ConnectorQueryRejectedError, MinuteQuota, type Clock } from '../common/errors.js';
import {
  MAX_METRIC_POINTS,
  MAX_METRIC_STEP_SECONDS,
  METRIC_UNITS,
  MIN_METRIC_STEP_SECONDS,
  type MetricName,
  type MetricPoint,
  type MetricSeries,
  type MetricsClient,
  type MetricsQuery,
} from './types.js';

export interface FakeMetricsOptions {
  /** Requests a minute before the fake answers 429. 0 or absent: no quota. */
  readonly quotaPerMinute?: number;
  readonly clock?: Clock;
  /** Services the fake knows. Any other slug comes back with no points. */
  readonly services?: readonly string[];
}

/** A number in [0, 1) from text, the same every run. */
function unit(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

/**
 * Time series with no randomness: the value at a step depends on the service, the metric and the
 * step's time only, so two calls (and two test runs) see the same line. A test can also script a
 * series with `set`.
 */
export class FakeMetricsClient implements MetricsClient {
  readonly source = 'fake' as const;
  readonly queries: MetricsQuery[] = [];
  readonly #quota: MinuteQuota;
  readonly #services: ReadonlySet<string> | null;
  readonly #scripted = new Map<string, readonly MetricPoint[]>();

  constructor(options: FakeMetricsOptions = {}) {
    this.#quota = new MinuteQuota(options.quotaPerMinute ?? 0, options.clock ?? Date.now);
    this.#services = options.services === undefined ? null : new Set(options.services);
  }

  /** Replaces the series of one service and metric; the points are returned as they are inside the range asked for. */
  set(service: string, metric: MetricName, points: readonly MetricPoint[]): void {
    this.#scripted.set(`${service}\u0000${metric}`, points);
  }

  queryTimeSeries(query: MetricsQuery): Promise<{ readonly series: readonly MetricSeries[] }> {
    this.queries.push(query);
    try {
      this.#quota.take();
      return Promise.resolve({ series: this.#series(query) });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('fake metrics failure'));
    }
  }

  #series(query: MetricsQuery): MetricSeries[] {
    const from = query.from.getTime();
    const to = query.to.getTime();
    const step = query.stepSeconds * 1000;
    if (
      !Number.isInteger(query.stepSeconds) ||
      query.stepSeconds < MIN_METRIC_STEP_SECONDS ||
      query.stepSeconds > MAX_METRIC_STEP_SECONDS
    ) {
      throw new ConnectorQueryRejectedError('stepSeconds must be 60 to 3600');
    }
    if (!(from < to) || (to - from) / step > MAX_METRIC_POINTS) {
      throw new ConnectorQueryRejectedError('The range is empty or asks for too many points');
    }
    if (query.metrics.length === 0) throw new ConnectorQueryRejectedError('No metric asked for');
    const known = this.#services === null || this.#services.has(query.service);
    return query.metrics.map((metric): MetricSeries => {
      const scripted = this.#scripted.get(`${query.service}\u0000${metric}`);
      if (scripted !== undefined) {
        return {
          metric,
          unit: METRIC_UNITS[metric],
          points: scripted.filter((point) => {
            const at = Date.parse(point.t);
            return at >= from && at < to;
          }),
        };
      }
      const points: MetricPoint[] = [];
      if (known) {
        // Align steps to the epoch so a moving range does not move the line.
        for (let at = Math.ceil(from / step) * step; at < to; at += step) {
          points.push({ t: new Date(at).toISOString(), v: this.#value(query.service, metric, at) });
        }
      }
      return { metric, unit: METRIC_UNITS[metric], points };
    });
  }

  #value(service: string, metric: MetricName, at: number): number {
    const base = unit(`${service}:${metric}`);
    const wave = Math.sin(at / 3_600_000 + base * 6);
    switch (metric) {
      case 'error_rate':
        return Math.round((0.002 + base * 0.01 + Math.max(0, wave) * 0.004) * 10000) / 10000;
      case 'latency_p95_ms':
        return Math.round(180 + base * 220 + wave * 40);
      case 'request_count':
        return Math.round(600 + base * 900 + wave * 120);
    }
  }
}
