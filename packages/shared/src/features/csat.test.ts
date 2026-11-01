import { describe, expect, it } from 'vitest';

import { emailJobSchema, EMAIL_SECRET_FIELDS, splitEmailSecrets } from '../queues.js';
import { LOG_REDACT_PATHS } from '../logging.js';
import {
  CSAT_REOPEN_BELOW_SCORE,
  CSAT_TOKEN_HEADER,
  csatResponseInputSchema,
  csatSettingsSchema,
  csatSurveyUrl,
} from './csat.js';

describe('csatSurveyUrl', () => {
  it('puts the token and the chosen rating in the fragment, never in the query', () => {
    const url = new URL(csatSurveyUrl('https://desk.example.test/csat', 'wtc1.a.b.c', 4));
    expect(url.search).toBe('');
    expect(url.hash).toBe('#token=wtc1.a.b.c&score=4');
  });

  it('leaves the rating out when there is none (the base link of the email)', () => {
    expect(new URL(csatSurveyUrl('https://desk.example.test/csat', 'wtc1.a.b.c')).hash).toBe(
      '#token=wtc1.a.b.c',
    );
  });
});

describe('the survey answer', () => {
  it.each([1, 2, 3, 4, 5])('accepts a score of %i', (score) => {
    expect(csatResponseInputSchema.safeParse({ score }).success).toBe(true);
  });

  it.each([0, 6, 2.5, '5', null, undefined, Number.NaN])('refuses a score of %j', (score) => {
    expect(csatResponseInputSchema.safeParse({ score }).success).toBe(false);
  });

  it('trims the comment, caps it at 2000 characters and refuses unknown fields', () => {
    expect(csatResponseInputSchema.parse({ score: 3, comment: '  hi  ' }).comment).toBe('hi');
    expect(csatResponseInputSchema.safeParse({ score: 3, comment: 'x'.repeat(2001) }).success).toBe(
      false,
    );
    expect(csatResponseInputSchema.safeParse({ score: 3, token: 'x' }).success).toBe(false);
  });

  it('a score below 3 reopens (R-1.10 says CSAT < 3, R-10.5 says <= 2: the same rule)', () => {
    expect(CSAT_REOPEN_BELOW_SCORE).toBe(3);
  });
});

describe('settings', () => {
  it('accepts 0 to 10080 whole minutes only', () => {
    for (const delayMinutes of [0, 60, 10_080]) {
      expect(csatSettingsSchema.safeParse({ delayMinutes }).success).toBe(true);
    }
    for (const delayMinutes of [-1, 10_081, 1.5, '60']) {
      expect(csatSettingsSchema.safeParse({ delayMinutes }).success).toBe(false);
    }
  });
});

describe('the survey email', () => {
  const job = {
    kind: 'csat_survey',
    to: 'a@example.test',
    locale: 'th',
    ticketKey: 'OPS-1',
    surveyUrl: 'https://desk.example.test/csat#token=wtc1.a.b.c',
    reminder: false,
  } as const;

  it('seals the link, so Redis and the outbox never hold the token', () => {
    expect(EMAIL_SECRET_FIELDS).toContain('surveyUrl');
    const { clear, secret } = splitEmailSecrets(job);
    expect(secret).toEqual({ surveyUrl: job.surveyUrl });
    expect(JSON.stringify(clear)).not.toContain('wtc1');
    expect(emailJobSchema.safeParse({ ...clear, ...secret }).success).toBe(true);
  });

  it('is not valid without the reminder flag or with a bad locale', () => {
    const withoutFlag: Record<string, unknown> = { ...job };
    delete withoutFlag.reminder;
    expect(emailJobSchema.safeParse(withoutFlag).success).toBe(false);
    expect(emailJobSchema.safeParse({ ...job, locale: 'fr' }).success).toBe(false);
  });
});

describe('logging', () => {
  it('redacts the survey and tracking token headers', () => {
    expect(CSAT_TOKEN_HEADER).toBe('x-csat-token');
    expect(LOG_REDACT_PATHS).toContain(`req.headers["${CSAT_TOKEN_HEADER}"]`);
    expect(LOG_REDACT_PATHS).toContain('req.headers["x-portal-token"]');
  });
});
