import { describe, expect, it } from 'vitest';

import { emailJobSchema, EMAIL_SECRET_FIELDS, splitEmailSecrets } from '../queues.js';
import { LOG_REDACT_PATHS } from '../logging.js';
import {
  CSAT_REOPEN_BELOW_SCORE,
  CSAT_TOKEN_HEADER,
  csatResponseInputSchema,
  csatSettingsSchema,
  csatSettingsUpdateSchema,
  csatSurveyUrl,
  stripCsatLinkTokens,
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
  const full = { enabled: true, delayMinutes: 60, reminderHours: 48, cooldownDays: 7 };

  it('accepts 0 to 10080 whole minutes only', () => {
    for (const delayMinutes of [0, 60, 10_080]) {
      expect(csatSettingsSchema.safeParse({ ...full, delayMinutes }).success).toBe(true);
    }
    for (const delayMinutes of [-1, 10_081, 1.5, '60']) {
      expect(csatSettingsSchema.safeParse({ ...full, delayMinutes }).success).toBe(false);
    }
  });

  it('bounds the reminder (0 = none, up to 720 h) and the cooldown (0 = none, up to 90 days)', () => {
    for (const reminderHours of [0, 48, 720]) {
      expect(csatSettingsSchema.safeParse({ ...full, reminderHours }).success).toBe(true);
    }
    for (const reminderHours of [-1, 721, 1.5]) {
      expect(csatSettingsSchema.safeParse({ ...full, reminderHours }).success).toBe(false);
    }
    for (const cooldownDays of [0, 7, 90]) {
      expect(csatSettingsSchema.safeParse({ ...full, cooldownDays }).success).toBe(true);
    }
    for (const cooldownDays of [-1, 91]) {
      expect(csatSettingsSchema.safeParse({ ...full, cooldownDays }).success).toBe(false);
    }
  });

  it('an update names the settings to change, at least one, nothing unknown', () => {
    expect(csatSettingsUpdateSchema.safeParse({ delayMinutes: 5 }).success).toBe(true);
    expect(csatSettingsUpdateSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(csatSettingsUpdateSchema.safeParse({}).success).toBe(false);
    expect(csatSettingsUpdateSchema.safeParse({ enabled: 'no' }).success).toBe(false);
    expect(csatSettingsUpdateSchema.safeParse({ other: 1 }).success).toBe(false);
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

describe('stripCsatLinkTokens (T-171 review C-8)', () => {
  const token =
    'wtc1.0123456789abcdef0123456789abcdef.lxyz12.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';

  it('removes a survey link token wherever it appears, and nothing else', () => {
    const text = `see https://x.test/csat#token=${token}&score=3 and ${token}!`;
    expect(stripCsatLinkTokens(text)).toBe(
      'see https://x.test/csat#token=[survey-link-removed]&score=3 and [survey-link-removed]!',
    );
    expect(stripCsatLinkTokens('plain wtc1.notatoken text')).toBe('plain wtc1.notatoken text');
    // the dots are dots, not "any character"
    expect(stripCsatLinkTokens(token.replaceAll('.', '-'))).toBe(token.replaceAll('.', '-'));
  });

  it('stays linear on a long run of the prefix', () => {
    const started = Date.now();
    stripCsatLinkTokens('wtc1.'.repeat(100_000));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
