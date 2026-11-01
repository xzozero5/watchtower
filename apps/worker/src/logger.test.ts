import { ProviderError } from '@watchtower/ai';
import { describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';
import { testConfig } from './testing/support.js';

describe('worker logger', () => {
  it('never serialises the cause of an error: a provider error keeps the prompt there (SR106-R10)', () => {
    const chunks: string[] = [];
    const logger = createLogger(testConfig({ LOG_LEVEL: 'trace' }), {
      write: (chunk: string) => chunks.push(chunk),
    });
    const cause = Object.assign(new Error('400 {"content":"PROMPT-WITH-[EMAIL_1]"}'), {
      requestBodyValues: { messages: 'SECRET-PROMPT-TEXT' },
      responseBody: 'SECRET-RESPONSE-TEXT',
    });
    logger.warn(
      { err: new ProviderError('vertex', 'APICallError', 500, true, { cause }) },
      'job failed',
    );
    const raw = chunks.join('');
    for (const secret of ['SECRET-PROMPT-TEXT', 'SECRET-RESPONSE-TEXT', 'PROMPT-WITH']) {
      expect(raw).not.toContain(secret);
    }
    const line = JSON.parse(raw) as { err: Record<string, unknown> };
    expect(line.err).toMatchObject({ type: 'ProviderError', causeTypes: ['Error'] });
    expect(line.err).not.toHaveProperty('cause');
  });
});
