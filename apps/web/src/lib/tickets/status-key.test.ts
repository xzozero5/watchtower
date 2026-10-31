import { TICKET_STATUSES } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { getMessages, translate } from '@/i18n';

import { statusKey } from './status-key';

describe('statusKey', () => {
  it('maps every ticket status to a camelCase copy key that exists in both languages', () => {
    for (const status of TICKET_STATUSES) {
      const key = statusKey(status);
      expect(key).toMatch(/^status\.[a-z]+(?:[A-Z][a-z]+)*$/);
      for (const locale of ['en', 'th'] as const) {
        expect(translate(getMessages(locale), key), `${locale} ${key}`).not.toBe(key);
      }
    }
  });

  it('uses the names from the UI spec', () => {
    expect(statusKey('waiting_on_customer')).toBe('status.waitingOnCustomer');
    expect(statusKey('waiting_on_dev')).toBe('status.waitingOnDev');
  });
});
