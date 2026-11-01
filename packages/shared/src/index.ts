export type IntegrationMode = 'mock' | 'live';

/**
 * An integration runs live only when every credential it needs is present. Empty or partial
 * configuration falls back to mock, so a local run can never reach a real service by accident.
 */
export function resolveIntegrationMode(
  credentials: readonly (string | undefined)[],
): IntegrationMode {
  if (credentials.length === 0) return 'mock';
  const complete = credentials.every((value) => value !== undefined && value.trim() !== '');
  return complete ? 'live' : 'mock';
}

export * from './audit-redact.js';
export * from './auth.js';
export * from './channels.js';
export * from './common.js';
export * from './directory.js';
export * from './features/index.js';
export * from './config.js';
export * from './logging.js';
export * from './portal.js';
export * from './queues.js';
export * from './rbac.js';
export * from './seed-data.js';
export * from './realtime.js';
export * from './redis-url.js';
export * from './sla.js';
export * from './ticketing.js';
export * from './views.js';
export * from './ops.js';
export * from './inbox.js';
