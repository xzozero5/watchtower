import type { AutonomyStage } from '@watchtower/ui';

import type { MessageKey } from '@/i18n';

export const STAGE_LABEL_KEYS: Record<AutonomyStage, MessageKey> = {
  0: 'admin.stage.label0',
  1: 'admin.stage.label1',
  2: 'admin.stage.label2',
  3: 'admin.stage.label3',
};

export const STAGE_HINT_KEYS: Record<AutonomyStage, MessageKey> = {
  0: 'admin.stage.hint0',
  1: 'admin.stage.hint1',
  2: 'admin.stage.hint2',
  3: 'admin.stage.hint3',
};

/** The stages a person can pick by hand. Stage 3 is reached only through a promotion the owner approves (N3). */
export const MANUAL_STAGES: readonly AutonomyStage[] = [0, 1, 2];

/**
 * The stage to show for a number from the api (0 to 3; the database refuses more). Stage 3 is drawn as
 * stage 3: showing it as 2 hid an intent that sends on its own. A number above 3 cannot occur and shows as 3.
 */
export function asStage(value: number): AutonomyStage {
  return value <= 0 ? 0 : value === 1 ? 1 : value === 2 ? 2 : 3;
}

/**
 * What an intent at stage 3 is doing now, for words next to the badge: `shadow` (it grades drafts and sends
 * nothing), `live` (it sends on its own), `held` (the instance switch is off, so it acts as stage 2).
 * Null below stage 3, or when the api did not say (an older api).
 */
export type Stage3Mode = 'shadow' | 'live' | 'held';
export function stage3Mode(intent: {
  stage: number;
  effectiveStage: number;
  autosend?: { shadow: boolean } | undefined;
}): Stage3Mode | null {
  if (intent.stage < 3) return null;
  if (intent.effectiveStage < 3) return 'held';
  if (intent.autosend === undefined) return null;
  return intent.autosend.shadow ? 'shadow' : 'live';
}

export const STAGE3_MODE_KEYS: Record<Stage3Mode, MessageKey> = {
  shadow: 'admin.stage.mode.shadow',
  live: 'admin.stage.mode.live',
  held: 'admin.stage.mode.held',
};
