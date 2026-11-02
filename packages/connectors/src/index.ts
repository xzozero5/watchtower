export const packageName = '@watchtower/connectors';

export * as alerts from './alerts/index.js';

// Read-only clients for investigation (T-203a, N2): each interface has no method that writes, and each has a fake.
export * from './common/errors.js';
export * from './common/template.js';
export * from './logs/types.js';
export * from './logs/filter.js';
export * from './logs/fake.js';
export * from './metrics/types.js';
export * from './metrics/fake.js';
export * from './data/types.js';
export * from './data/guard.js';
export * from './data/fake.js';
export * from './repo/types.js';
export * from './repo/fake.js';
export * from './mock.js';
export * from './templates.js';
export * from './clients.js';
