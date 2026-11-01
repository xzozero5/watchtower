import { describe, expect, it } from 'vitest';

import { sanitizeAlertPayload, sanitizeAlertUrl, scrubAlertText } from './alerts.js';

describe('sanitizeAlertUrl (N1)', () => {
  it('removes a user name and password, a fragment and credential-looking parameters', () => {
    const link = sanitizeAlertUrl(
      'https://user:pa55@console.example.invalid/alert/1?project=p&token=abc&api_key=k&sig=s&x=1#access_token=zzz',
    );
    expect(link).toBe('https://console.example.invalid/alert/1?project=p&x=1');
  });

  it('can drop the whole query, for a link whose query is an expression', () => {
    expect(
      sanitizeAlertUrl('https://prom.example.invalid/graph?g0.expr=up{customer="Acme"}', {
        keepQuery: false,
      }),
    ).toBe('https://prom.example.invalid/graph');
  });

  it.each(['javascript:alert(1)', 'ftp://x.example.invalid/', 'not a url', '', 3, null, undefined])(
    'refuses %s',
    (value) => {
      expect(sanitizeAlertUrl(value)).toBeNull();
    },
  );

  it('is applied to every link in the stored payload', () => {
    const payload = sanitizeAlertPayload({
      url: 'https://u:p@c.example.invalid/a?token=1&project=p',
      generatorUrl: 'https://u:p@prom.example.invalid/graph?g0.expr=x#frag',
      externalUrl: 'javascript:alert(1)',
    });
    expect(payload.url).toBe('https://c.example.invalid/a?project=p');
    expect(payload.generatorUrl).toBe('https://prom.example.invalid/graph');
    expect(payload).not.toHaveProperty('externalUrl');
    expect(JSON.stringify(payload)).not.toMatch(/u:p|token=|frag/);
  });
});

describe('scrubAlertText (N4)', () => {
  it.each([
    ['mail jane.doe@example.invalid now', 'mail [email] now'],
    ['password: hunter2 was used', 'password: [secret] was used'],
    ['Bearer abc.def.ghi leaked', 'Bearer [secret] leaked'],
    ['call 081-234-5678 please', 'call [phone] please'],
    ['call +66 81 234 5678 please', 'call [phone] please'],
    ['id 1-2345-67890-12-3 and 1234567890123', 'id [id] and [id]'],
    ['see https://admin:s3cret@host.example.invalid/x', 'see https://host.example.invalid/x'],
  ])('%s', (input, expected) => {
    expect(scrubAlertText(input)).toBe(expected);
  });

  it('leaves a monitoring summary with long resource ids alone', () => {
    const text =
      'CPU for VM Instance labels {instance_id=1234567890123456789, zone=asia-southeast1-a} is above 0.9';
    expect(scrubAlertText(text)).toBe(text);
  });

  it('is applied to the summary kept in the payload', () => {
    expect(sanitizeAlertPayload({ summary: 'ask jane@example.invalid' }).summary).toBe(
      'ask [email]',
    );
  });
});
