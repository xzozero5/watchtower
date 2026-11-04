import type { AiCallGuard } from './guard.js';

/** A guard that allows every call, for tests that are not about the guard. */
export const ALLOW_ALL_GUARD: AiCallGuard = {
  check: () => Promise.resolve({ allowed: true }),
};
