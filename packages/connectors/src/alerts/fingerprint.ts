import { createHash } from 'node:crypto';

import type { AlertSource } from '@watchtower/shared';

export interface FingerprintParts {
  readonly source: AlertSource;
  /** Policy name (GCP) or `alertname` (Alertmanager). */
  readonly name: string;
  readonly condition: string;
  readonly resourceType: string;
  /** EVERY label the provider sent, not only the ones that are stored: alerts that differ stay apart. */
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * The identity of an alert (R-3.5): policy + resource + condition for GCP, the label set for
 * Alertmanager. SHA-256 of a canonical JSON (labels sorted by key, so the order the provider happened
 * to use does not matter). A hash, so no label value leaks through it.
 */
export function alertFingerprint(parts: FingerprintParts): string {
  const labels = Object.entries(parts.labels).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = JSON.stringify([
    'watchtower-alert-v1',
    parts.source,
    parts.name.trim().toLowerCase(),
    parts.condition.trim().toLowerCase(),
    parts.resourceType.trim().toLowerCase(),
    labels,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
