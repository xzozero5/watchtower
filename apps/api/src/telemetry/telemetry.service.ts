import { Inject, Injectable, Optional, type OnApplicationShutdown } from '@nestjs/common';
import {
  SpanKind,
  SpanStatusCode,
  type Histogram,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  TracerProvider,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';

/** Optional DI token for a SpanExporter. Production leaves it unset; OTLP is chosen by config. */
export const SPAN_EXPORTER = Symbol('SPAN_EXPORTER');

const SECONDS_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface RequestObservation {
  readonly method: string;
  /** Matched route pattern such as `/health/ready`, never the raw path (keeps labels bounded). */
  readonly route: string;
  readonly statusCode: number;
  readonly durationSeconds: number;
}

/**
 * OpenTelemetry for the API.
 *
 * - Metrics: always on, pulled by Prometheus from GET /metrics. Nothing is pushed anywhere.
 * - Traces: recorded in process; exported over OTLP/HTTP only when OTEL_EXPORTER_OTLP_ENDPOINT is
 *   set. The default is no exporter, so nothing leaves the machine (PRD section 8.1).
 */
@Injectable()
export class TelemetryService implements OnApplicationShutdown {
  private readonly prometheus: PrometheusExporter;
  private readonly meterProvider: MeterProvider;
  private readonly tracerProvider: TracerProvider;
  private readonly tracer: Tracer;
  private readonly httpDuration: Histogram;

  constructor(
    @Inject(APP_CONFIG) config: ApiConfig,
    /** Test seam: provide a span exporter under this token to capture spans. */
    @Optional() @Inject(SPAN_EXPORTER) exporter?: SpanExporter,
  ) {
    const resource = resourceFromAttributes({
      'service.name': config.OTEL_SERVICE_NAME,
      'deployment.environment.name': config.NODE_ENV,
    });

    // preventServerStart: the API serves /metrics itself; the exporter must not open a port.
    this.prometheus = new PrometheusExporter({
      preventServerStart: true,
      withoutScopeInfo: true,
      withoutTargetInfo: true,
    });
    this.meterProvider = new MeterProvider({ resource, readers: [this.prometheus] });
    const meter = this.meterProvider.getMeter('watchtower-api');

    this.httpDuration = meter.createHistogram('http.server.request.duration', {
      description: 'Duration of inbound HTTP requests',
      unit: 's',
      advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
    });
    meter
      .createObservableGauge('process.resident_memory', {
        description: 'Resident set size',
        unit: 'By',
      })
      .addCallback((result) => {
        result.observe(process.memoryUsage().rss);
      });
    meter
      .createObservableGauge('process.uptime', { description: 'Process uptime', unit: 's' })
      .addCallback((result) => {
        result.observe(process.uptime());
      });

    const spanProcessors: SpanProcessor[] = [];
    const spanExporter =
      exporter ?? (config.OTEL_EXPORTER_OTLP_ENDPOINT ? otlpExporter(config) : undefined);
    if (spanExporter) spanProcessors.push(new BatchSpanProcessor({ exporter: spanExporter }));
    this.tracerProvider = new TracerProvider({ resource, spanProcessors });
    this.tracer = this.tracerProvider.getTracer('watchtower-api');
  }

  /** Starts the server span for a request. Pass the result to `finishRequest`. */
  startRequest(method: string, path: string): Span {
    return this.tracer.startSpan(`HTTP ${method}`, {
      kind: SpanKind.SERVER,
      attributes: { 'http.request.method': method, 'url.path': path },
    });
  }

  finishRequest(span: Span, observation: RequestObservation): void {
    this.httpDuration.record(observation.durationSeconds, {
      'http.request.method': observation.method,
      'http.route': observation.route,
      'http.response.status_code': observation.statusCode,
    });
    span.updateName(`${observation.method} ${observation.route}`);
    span.setAttributes({
      'http.route': observation.route,
      'http.response.status_code': observation.statusCode,
    });
    if (observation.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  }

  /** Writes the Prometheus text exposition for GET /metrics. */
  writeMetrics(request: IncomingMessage, response: ServerResponse): void {
    this.prometheus.getMetricsRequestHandler(request, response);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.tracerProvider.shutdown();
    await this.meterProvider.shutdown();
  }
}

function otlpExporter(config: ApiConfig): SpanExporter {
  const base = config.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';
  return new OTLPTraceExporter({ url: new URL('v1/traces', base.replace(/\/?$/, '/')).toString() });
}
