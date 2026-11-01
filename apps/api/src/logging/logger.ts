import type { LoggerService } from '@nestjs/common';
import { LOG_REDACT_CENSOR, LOG_REDACT_PATHS, stripErrorCauses } from '@watchtower/shared';
import { pino, type DestinationStream, type Logger } from 'pino';

import type { ApiConfig } from '../config/config.js';

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
    serializers: {
      err: (error: Error) => stripErrorCauses(pino.stdSerializers.err(error)),
      error: (error: Error) => stripErrorCauses(pino.stdSerializers.err(error)),
    },
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
    const stack = level === 'error' && strings.length > 1 ? strings[0] : undefined;
    const bindings = {
      ...(context === undefined ? {} : { context }),
      ...(stack === undefined ? {} : { stack }),
    };
    if (message instanceof Error) {
      this.logger[level]({ ...bindings, err: message }, message.message);
    } else if (typeof message === 'string') {
      this.logger[level](bindings, message);
    } else {
      this.logger[level]({ ...bindings, detail: message }, 'log');
    }
  }
}
