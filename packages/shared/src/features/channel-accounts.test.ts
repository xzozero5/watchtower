import { describe, expect, it } from 'vitest';

import { createChannelAccountSchema, lineWebhookPath } from './channel-accounts.js';

describe('createChannelAccountSchema', () => {
  it('accepts a LINE account with a name only and trims the name', () => {
    expect(createChannelAccountSchema.parse({ type: 'line', name: '  Support  ' })).toEqual({
      type: 'line',
      name: 'Support',
    });
  });

  it('lower-cases and trims a mailbox address', () => {
    expect(
      createChannelAccountSchema.parse({
        type: 'gmail',
        name: 'Box',
        emailAddress: '  Help@Example.COM ',
      }),
    ).toEqual({ type: 'gmail', name: 'Box', emailAddress: 'help@example.com' });
  });

  it('refuses what does not fit the type', () => {
    for (const body of [
      { type: 'line' },
      { type: 'line', name: ' ' },
      { type: 'line', name: 'x', emailAddress: 'a@example.com' },
      { type: 'gmail', name: 'x' },
      { type: 'gmail', name: 'x', emailAddress: 'nope' },
      { type: 'portal', name: 'x' },
      { type: 'gmail', name: 'x'.repeat(121), emailAddress: 'a@example.com' },
    ]) {
      expect(createChannelAccountSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('lineWebhookPath', () => {
  it('is the receiver path of the account', () => {
    expect(lineWebhookPath('0b3f6f64-3c1e-4f43-b8a9-5a4d6a1b2c3d')).toBe(
      '/v1/inbound/line/0b3f6f64-3c1e-4f43-b8a9-5a4d6a1b2c3d',
    );
  });
});
