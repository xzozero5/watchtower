import type { ClientSource } from '../common/errors.js';

/**
 * Read-only access to Cloud Monitoring time series (R-5.5): what the service status panel and the
 * AI evidence need. One method, and it reads. The live adapter (T-208) is `[ASK-HUMAN]`.
 */

export const METRIC_NAMES = ['error_rate', 'latency_p95_ms', 'request_count'] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export const METRIC_UNITS: Readonly<Record<MetricName, 'ratio' | 'ms' | 'count'>> = {
  error_rate: 'ratio',
  latency_p95_ms: 'ms',
  request_count: 'count',
};

export interface MetricPoint {
  /** Start of the step, ISO 8601 UTC. */
  readonly t: string;
  readonly v: number;
}

export interface MetricSeries {
  readonly metric: MetricName;
  readonly unit: 'ratio' | 'ms' | 'count';
  readonly points: readonly MetricPoint[];
}

export interface MetricsQuery {
  /** Slug of a service in the catalog. */
  readonly service: string;
  readonly metrics: readonly MetricName[];
  readonly from: Date;
  readonly to: Date;
  /** 60 to 3600 seconds. */
  readonly stepSeconds: number;
  readonly signal?: AbortSignal | undefined;
}

export const MIN_METRIC_STEP_SECONDS = 60;
export const MAX_METRIC_STEP_SECONDS = 3600;
/** At most this many points a series, so a bad range cannot ask for a million. */
export const MAX_METRIC_POINTS = 1500;

export interface MetricsClient {
  readonly source: ClientSource;
  /** One request against the Monitoring quota. A metric the service has no data for comes back with no points. */
  queryTimeSeries(query: MetricsQuery): Promise<{ readonly series: readonly MetricSeries[] }>;
}
