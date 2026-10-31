import { hkdfSync } from 'node:crypto';

import type { ApiConfig } from '../config/config.js';

/** One label per purpose, so a key made for one use can never validate something made for another. */
export const PORTAL_KEY_LABELS = {
  trackingToken: 'watchtower/portal/tracking-token/v1',
  proofOfWork: 'watchtower/portal/proof-of-work/v1',
} as const;

/**
 * A 256-bit signing key for one purpose, derived (HKDF-SHA-256) from `PORTAL_TOKEN_SECRET`, or from
 * `APP_ENCRYPTION_KEY` when that is empty (ADR-004: infra secrets live in the environment). Nothing
 * here is stored; changing either variable invalidates what was signed with the old value.
 */
export function derivePortalKey(
  config: Pick<ApiConfig, 'PORTAL_TOKEN_SECRET' | 'APP_ENCRYPTION_KEY'>,
  label: string,
): Buffer {
  const root = config.PORTAL_TOKEN_SECRET ?? config.APP_ENCRYPTION_KEY;
  return Buffer.from(hkdfSync('sha256', root, 'watchtower-portal', label, 32));
}
