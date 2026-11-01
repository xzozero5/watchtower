import { describe, expect, it } from 'vitest';

import { alerts, packageName } from './index.js';

describe('@watchtower/connectors', () => {
  it('names itself and exposes the alert normalizers', () => {
    expect(packageName).toBe('@watchtower/connectors');
    expect(typeof alerts.normalizeGcpAlert).toBe('function');
    expect(typeof alerts.normalizeAlertmanager).toBe('function');
    expect(typeof alerts.verifyAlertWebhook).toBe('function');
  });

  it('has no method that writes: nothing exported is named like a write (N2)', () => {
    const names = Object.keys(alerts);
    expect(
      names.filter((name) =>
        /^(create|update|delete|write|post|put|patch|send|insert)/i.test(name),
      ),
    ).toEqual([]);
  });
});
