import { ProviderError } from '@watchtower/ai';
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

  it('censors the bearer token of a Pub/Sub push wherever the header shows up (T-207a C-10)', () => {
    const { capture, logger } = loggerWithCapture();
    const token = 'eyJhbGciOiJSUzI1NiJ9.PUBSUB-OIDC-TOKEN.signature';
    logger.info({ req: { headers: { authorization: `Bearer ${token}` } } }, 'push');
    logger.info({ req: { headers: { Authorization: `Bearer ${token}` } } }, 'push, capitalised');
    logger.info({ req: { headers: { 'proxy-authorization': `Bearer ${token}` } } }, 'proxy');
    logger.error({ err: { config: { headers: { Authorization: `Bearer ${token}` } } } }, 'client');
    logger.error({ res: { request: { headers: { authorization: `Bearer ${token}` } } } }, 'deep');
    const raw = capture.raw();
    expect(raw).not.toContain('PUBSUB-OIDC-TOKEN');
    expect(raw).toContain('[Redacted]');
  });

  it('never serialises the cause of an error: a provider error keeps the prompt there (SR106-R10)', () => {
    const { capture, logger } = loggerWithCapture();
    const cause = Object.assign(
      new Error('400 {"messages":[{"content":"PROMPT-WITH-[EMAIL_1]"}]}'),
      {
        requestBodyValues: { messages: 'SECRET-PROMPT-TEXT' },
        responseBody: 'SECRET-RESPONSE-TEXT',
      },
    );
    const error = new ProviderError('anthropic', 'APICallError', 400, false, { cause });
    logger.error({ err: error }, 'call failed');
    logger.error({ error: new AggregateError([cause], 'agg', { cause }) }, 'again');
    const raw = capture.raw();
    for (const secret of ['SECRET-PROMPT-TEXT', 'SECRET-RESPONSE-TEXT', 'PROMPT-WITH']) {
      expect(raw).not.toContain(secret);
    }
    const [first] = capture.lines();
    expect(first?.err).toMatchObject({
      type: 'ProviderError',
      message: 'Provider call failed (anthropic: APICallError 400)',
      causeTypes: ['Error'],
    });
    expect(first?.err).not.toHaveProperty('cause');
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

  describe('a failed database statement (T-140 security review)', () => {
    const SQL = 'insert into "message" ("body_text", "attachments") values ($1, $2)';
    const SECRET = 'Nok Customer <nok@customer.example> secret-plan.pdf';
    const failed = () => {
      const pg = Object.assign(new Error('unsupported Unicode escape sequence'), { code: '22P05' });
      const error = new Error(`Failed query: ${SQL}\nparams: ${SECRET},[{"filename":"x"}]`, {
        cause: pg,
      });
      error.name = 'DrizzleQueryError';
      return error;
    };

    it('never logs the statement or its parameters, from Nest or from a direct log call', () => {
      const { capture, logger } = loggerWithCapture();
      const nest = new NestPinoLogger(logger);
      const error = failed();
      nest.error(error.message, error.stack, 'ExceptionsHandler');
      nest.error(error);
      logger.error({ err: error }, 'request failed');
      const raw = capture.raw();
      expect(raw).not.toContain('secret-plan');
      expect(raw).not.toContain('nok@customer.example');
      expect(raw).not.toContain('insert into');
      expect(raw).toContain('Failed query: [redacted]');
    });

    it('keeps the database error code and the error type', () => {
      const { capture, logger } = loggerWithCapture();
      logger.error({ err: failed() }, 'request failed');
      expect(capture.lines()[0]).toMatchObject({
        err: { type: 'DrizzleQueryError', code: '22P05' },
      });
    });
  });
});
