import { z } from 'zod';

export const livenessSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
});
export type Liveness = z.infer<typeof livenessSchema>;

export const dependencyCheckSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().nonnegative(),
});

export const readinessSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  checks: z.object({
    database: dependencyCheckSchema,
    redis: dependencyCheckSchema,
  }),
});
export type Readiness = z.infer<typeof readinessSchema>;
