import { describe, expect, it } from 'vitest';

import { DATA_COLUMN_ALLOW_LIST, isPiiColumnName, usageDimProblem } from './tools.js';
import { createMetricSchema, updateMetricSchema } from './usage.js';

const metric = (dims: string[]) => ({
  key: 'jobs_per_hour',
  name: 'Jobs per hour',
  sqlTemplate: 'SELECT $1::timestamptz AS ts, $2::int AS value',
  dims,
});

describe('usage metric dimensions (T-207a C-5)', () => {
  it('accepts the allow-listed columns and plain categories', () => {
    for (const dims of [['org', 'flow', 'step'], ['org_id', 'status', 'region'], ['plan']]) {
      expect(createMetricSchema.safeParse(metric(dims)).success, dims.join()).toBe(true);
    }
  });

  it.each([
    'display_name',
    'contact_email',
    'submitted_by',
    'email',
    'user_name',
    'customer_name',
    'phone_number',
    'line_id',
    'billing_address',
    'api_token',
    'account_holder',
  ])('refuses %s, which looks like a person', (name) => {
    expect(isPiiColumnName(name)).toBe(true);
    expect(createMetricSchema.safeParse(metric([name])).success).toBe(false);
    expect(updateMetricSchema.safeParse({ dims: [name] }).success).toBe(false);
  });

  it('never refuses a column of the global allow-list', () => {
    for (const name of DATA_COLUMN_ALLOW_LIST) {
      expect(usageDimProblem(name), name).toBeNull();
    }
  });
});
