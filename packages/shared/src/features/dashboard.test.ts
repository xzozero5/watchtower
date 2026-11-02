import { describe, expect, it } from 'vitest';

import {
  DASHBOARD_MAX_DAYS,
  DASHBOARD_NOT_AVAILABLE_REASONS,
  dashboardQuerySchema,
  dashboardValue,
} from './dashboard.js';
import { z } from 'zod';

describe('dashboardQuerySchema', () => {
  it('defaults to a week and accepts 1 to the maximum', () => {
    expect(dashboardQuerySchema.parse({}).days).toBe(7);
    expect(dashboardQuerySchema.parse({ days: '30' }).days).toBe(30);
    expect(dashboardQuerySchema.parse({ days: String(DASHBOARD_MAX_DAYS) }).days).toBe(
      DASHBOARD_MAX_DAYS,
    );
  });

  it.each(['0', '-1', String(DASHBOARD_MAX_DAYS + 1), '1.5', 'x'])('refuses days=%s', (days) => {
    expect(dashboardQuerySchema.safeParse({ days }).success).toBe(false);
  });
});

describe('dashboardValue', () => {
  const schema = dashboardValue(z.strictObject({ n: z.number() }));

  it('carries the figure, why it is missing, or that the role does not see it', () => {
    expect(schema.safeParse({ status: 'ok', data: { n: 0 } }).success).toBe(true);
    for (const reason of DASHBOARD_NOT_AVAILABLE_REASONS) {
      expect(schema.safeParse({ status: 'not_available', reason }).success).toBe(true);
    }
    expect(schema.safeParse({ status: 'restricted', requires: 'csat.read' }).success).toBe(true);
  });

  it('does not let a missing figure pass as a number or a reason be invented', () => {
    expect(schema.safeParse({ status: 'not_available', reason: 'zero' }).success).toBe(false);
    expect(schema.safeParse({ status: 'not_available', data: { n: 0 } }).success).toBe(false);
    expect(schema.safeParse({ status: 'ok' }).success).toBe(false);
  });
});
