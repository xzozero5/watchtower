import type { LoggerService } from '@nestjs/common';
import {
  LOG_REDACT_CENSOR,
  LOG_REDACT_PATHS,
  serializeErrorForLog,
  stripQueryParams,
} from '@watchtower/shared';
import { pino, type DestinationStream, type Logger } from 'pino';

import type { ApiConfig } from '../config/config.js';

const FAILED_QUERY = /Failed query:[\s\S]*?(?=\r?\n\s+at |$)/g;

/**
 * Text of an error with the database statement and its bound parameters removed. A failed Drizzle
 * query puts both in its message (`Failed query: <sql>\nparams: <values>`), and the values are what a
 * customer typed: messages, names, file names. Everything else in the text is kept.
 */
export function scrubErrorText(text: string): string {
  return stripQueryParams(text.replace(FAILED_QUERY, 'Failed query: [redacted]'));
}

/** The `err` serializer: the shared one, with statements removed and the database's own error code kept. */
export function serializeApiError(error: unknown): unknown {
  const out = serializeErrorForLog(error);
  if (typeof out !== 'object' || out === null) return out;
  const serialized = { ...(out as Record<string, unknown>) };
  for (const key of ['message', 'stack']) {
    const value = serialized[key];
    if (typeof value === 'string') serialized[key] = scrubErrorText(value);
  }
  // pg's error sits in `cause` of a DrizzleQueryError; its code (23505, 22P05) says what went wrong.
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const code =
    typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && serialized.code === undefined) serialized.code = code;
  return serialized;
}

/** DI token for the pino logger. Inject with `@Inject(LOGGER)`. */
export const LOGGER = Symbol('LOGGER');

export type AppLogger = Logger;

/**
 * Structured JSON logger (one object per line on stdout, which Cloud Logging parses as-is).
 * Credential fields are censored by path (LOG_REDACT_PATHS); callers must still not log secrets.
 */
export function createLogger(
  config: Pick<ApiConfig, 'LOG_LEVEL' | 'NODE_ENV' | 'OTEL_SERVICE_NAME'>,
  destination?: DestinationStream,
): AppLogger {
  const options = {
    level: config.LOG_LEVEL,
    base: { service: config.OTEL_SERVICE_NAME, env: config.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
    redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR },
    // An error's `cause` can hold the request or response body of a provider call (a prompt):
    // log the type names of the chain, never its contents (SR106-R10).
    serializers: { err: serializeApiError, error: serializeApiError },
  };
  return destination ? pino(options, destination) : pino(options);
}

/** Routes Nest's own logging (startup, route mapping, unhandled errors) through pino. */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: AppLogger) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('trace', message, rest);
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }

  private write(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: unknown,
    rest: readonly unknown[],
  ): void {
    // Nest passes the context name last, and a stack before it for errors.
    const strings = rest.filter((item): item is string => typeof item === 'string');
    const context = strings.at(-1);
    const stack =
      level === 'error' && strings.length > 1 && strings[0] !== undefined
        ? scrubErrorText(strings[0])
        : undefined;
    const bindings = {
      ...(context === undefined ? {} : { context }),
      ...(stack === undefined ? {} : { stack }),
    };
    if (message instanceof Error) {
      this.logger[level]({ ...bindings, err: message }, scrubErrorText(message.message));
    } else if (typeof message === 'string') {
      // Nest logs an unhandled exception as its message string plus its stack string.
      this.logger[level](bindings, scrubErrorText(message));
    } else {
      this.logger[level]({ ...bindings, detail: message }, 'log');
    }
  }
}
