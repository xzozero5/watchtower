/**
 * Incident and ticket severity, P1 (most urgent) to P4. Severity must never be conveyed by colour
 * alone (PRD section 10): every level has its own code, its own icon shape and a translated label.
 * The colours live with the other colour tokens in colors.ts.
 */
export const SEVERITY_IDS = ['p1', 'p2', 'p3', 'p4'] as const;

export type SeverityId = (typeof SEVERITY_IDS)[number];

/** Icon names are lucide shapes chosen to differ in silhouette, not just in colour. */
export type SeverityIconName = 'octagon-alert' | 'triangle-alert' | 'circle-alert' | 'info';

export interface SeverityDefinition {
  /** Short text shown in the badge. Not translated: "P1" reads the same in Thai and English. */
  readonly code: string;
  /** 1 is the most urgent. Use it for sorting. */
  readonly rank: number;
  readonly icon: SeverityIconName;
}

export const SEVERITIES: Readonly<Record<SeverityId, SeverityDefinition>> = {
  p1: { code: 'P1', rank: 1, icon: 'octagon-alert' },
  p2: { code: 'P2', rank: 2, icon: 'triangle-alert' },
  p3: { code: 'P3', rank: 3, icon: 'circle-alert' },
  p4: { code: 'P4', rank: 4, icon: 'info' },
};
