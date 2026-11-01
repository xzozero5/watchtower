import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import { resolveSmtpSecurity, smtpSettingsIssues, type SmtpSettings } from './mailer.js';
import { testEnv } from './testing/support.js';

const base: SmtpSettings = { host: 'smtp.example.test', port: 587, from: 'x <x@example.test>' };

describe('resolveSmtpSecurity', () => {
  it('uses implicit TLS on 465 and STARTTLS on 587', () => {
    expect(resolveSmtpSecurity({ ...base, port: 465 })).toBe('implicit-tls');
    expect(resolveSmtpSecurity({ ...base, port: 587 })).toBe('starttls');
  });

  it('keeps plain SMTP only for a non-production port such as Mailpit 1025', () => {
    expect(resolveSmtpSecurity({ ...base, port: 1025 })).toBe('opportunistic');
    expect(resolveSmtpSecurity({ ...base, port: 1025, production: true })).toBe('starttls');
    expect(resolveSmtpSecurity({ ...base, port: 465, production: true })).toBe('implicit-tls');
  });
});

describe('smtpSettingsIssues', () => {
  it('accepts Mailpit locally without an account', () => {
    expect(smtpSettingsIssues({ ...base, host: 'mailpit', port: 1025 })).toEqual([]);
  });

  it('refuses a plain unauthenticated send in production unless it is explicitly allowed', () => {
    const production = { ...base, port: 25, production: true };
    expect(smtpSettingsIssues(production).map((issue) => issue.variable)).toEqual(['SMTP_USER']);
    expect(smtpSettingsIssues({ ...production, allowInsecure: true })).toEqual([]);
  });

  it('accepts an authenticated send over TLS in production', () => {
    expect(smtpSettingsIssues({ ...base, production: true, user: 'u', password: 'p' })).toEqual([]);
    expect(
      smtpSettingsIssues({ ...base, port: 465, production: true, user: 'u', password: 'p' }),
    ).toEqual([]);
  });

  it('wants user and password together, and never sends them over an unencrypted port', () => {
    expect(smtpSettingsIssues({ ...base, user: 'u' }).map((issue) => issue.variable)).toEqual([
      'SMTP_PASSWORD',
    ]);
    expect(
      smtpSettingsIssues({ ...base, port: 1025, user: 'u', password: 'p' }).map(
        (issue) => issue.variable,
      ),
    ).toEqual(['SMTP_PORT']);
  });

  it('names variables only, never the password', () => {
    const secret = 'correct-horse-battery-staple';
    const text = JSON.stringify(
      smtpSettingsIssues({ ...base, port: 1025, user: 'u', password: secret }),
    );
    expect(text).not.toContain(secret);
  });
});

describe('worker config SMTP variables', () => {
  it('defaults to no account and no allowance', () => {
    const config = loadConfig(testEnv());
    expect(config.SMTP_USER).toBeUndefined();
    expect(config.SMTP_PASSWORD).toBeUndefined();
    expect(config.SMTP_ALLOW_INSECURE).toBe(false);
  });

  it('refuses to boot in production against Mailpit-style plain SMTP, without echoing values', () => {
    const production = {
      NODE_ENV: 'production',
      JWT_SECRET: 'j'.repeat(40),
      APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      GOOGLE_OIDC_CLIENT_ID: 'id',
      GOOGLE_OIDC_CLIENT_SECRET: 's',
      GOOGLE_ALLOWED_DOMAIN: 'example.test',
      GMAIL_MOCK_ENABLED: undefined,
      SMTP_PORT: '1025',
    };
    expect(() => loadConfig(testEnv(production))).toThrow(/SMTP_USER/);
    expect(() => loadConfig(testEnv({ ...production, SMTP_ALLOW_INSECURE: 'true' }))).not.toThrow();
    expect(
      loadConfig(testEnv({ ...production, SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASSWORD: 'p' }))
        .SMTP_USER,
    ).toBe('u');
  });
});
