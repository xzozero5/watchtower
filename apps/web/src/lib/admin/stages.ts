import type { AutonomyStage } from '@watchtower/ui';

import type { MessageKey } from '@/i18n';

export const STAGE_LABEL_KEYS: Record<AutonomyStage, MessageKey> = {
  0: 'admin.stage.label0',
  1: 'admin.stage.label1',
  2: 'admin.stage.label2',
};

export const STAGE_HINT_KEYS: Record<AutonomyStage, MessageKey> = {
  0: 'admin.stage.hint0',
  1: 'admin.stage.hint1',
  2: 'admin.stage.hint2',
};

/**
 * The stage to show for a number from the api. Phase 1 has stages 0 to 2 only (N3): a higher value
 * cannot occur (the database refuses it) and is never drawn as its own stage, so it shows as 2.
 */
export function asStage(value: number): AutonomyStage {
  return value <= 0 ? 0 : value === 1 ? 1 : 2;
}
