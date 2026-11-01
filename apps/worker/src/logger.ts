import { LOG_REDACT_CENSOR, LOG_REDACT_PATHS, serializeErrorForLog } from '@watchtower/shared';
import { pino, type DestinationStream, type Logger } from 'pino';

import type { WorkerConfig } from './config.js';

export type WorkerLogger = Logger;

/** Structured JSON logger, one object per line on stdout. Credential fields are censored. */
export function createLogger(
  config: Pick<WorkerConfig, 'LOG_LEVEL' | 'NODE_ENV' | 'OTEL_SERVICE_NAME'>,
  destination?: DestinationStream,
): WorkerLogger {
  const options = {
    level: config.LOG_LEVEL,
    base: { service: config.OTEL_SERVICE_NAME, env: config.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
    redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR },
    // An error's `cause` can hold the request or response body of a provider call (a prompt):
    // log the type names of the chain, never its contents (SR106-R10).
    serializers: { err: serializeErrorForLog, error: serializeErrorForLog },
  };
  return destination ? pino(options, destination) : pino(options);
}
