import { describe, expect, it } from 'vitest';

import { captureLogs, testConfig } from '../testing/support.js';
import { createLogger, NestPinoLogger } from './logger.js';

function loggerWithCapture() {
  const capture = captureLogs();
  const logger = createLogger(testConfig({ LOG_LEVEL: 'trace' }), capture.destination);
  return { capture, logger };
}

describe('createLogger', () => {
  it('writes one JSON object per line with level, time, service and env', () => {
    const { capture, logger } = loggerWithCapture();
    logger.info({ ticket: 12 }, 'hello');
    const [line] = capture.lines();
    expect(line).toMatchObject({
      level: 'info',
      msg: 'hello',
      ticket: 12,
      service: 'watchtower-api',
      env: 'test',
    });
    expect(typeof line?.time).toBe('string');
  });

  it('censors credential fields and request headers', () => {
    const { capture, logger } = loggerWithCapture();
    logger.info(
      {
        req: { headers: { authorization: 'Bearer abc.def', cookie: 'sid=1', accept: 'text/html' } },
        user: { password: 'hunter2', token: 'tok-123', name: 'Somchai' },
        config: { apiKey: 'sk-live-xyz', clientSecret: 's3cr3t' },
      },
      'sensitive',
    );
    const raw = capture.raw();
    for (const secret of [
      'Bearer abc.def',
      'sid=1',
      'hunter2',
      'tok-123',
      'sk-live-xyz',
      's3cr3t',
    ]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).toContain('[Redacted]');
    expect(raw).toContain('Somchai');
    expect(raw).toContain('text/html');
  });

  it('honours LOG_LEVEL', () => {
    const capture = captureLogs();
    const logger = createLogger(testConfig({ LOG_LEVEL: 'warn' }), capture.destination);
    logger.info('quiet');
    logger.warn('loud');
    expect(capture.lines().map((line) => line.msg)).toEqual(['loud']);
  });
});

describe('NestPinoLogger', () => {
  it('maps Nest levels and context onto pino', () => {
    const { capture, logger } = loggerWithCapture();
    const nest = new NestPinoLogger(logger);
    nest.log('started', 'NestApplication');
    nest.verbose('detail', 'Router');
    nest.error('boom', 'stack-trace', 'ExceptionsHandler');
    expect(capture.lines()).toMatchObject([
      { level: 'info', msg: 'started', context: 'NestApplication' },
      { level: 'trace', msg: 'detail', context: 'Router' },
      { level: 'error', msg: 'boom', context: 'ExceptionsHandler', stack: 'stack-trace' },
    ]);
  });

  it('logs an Error with its message', () => {
    const { capture, logger } = loggerWithCapture();
    new NestPinoLogger(logger).error(new Error('kaput'));
    expect(capture.lines()[0]).toMatchObject({ level: 'error', msg: 'kaput' });
  });
});
