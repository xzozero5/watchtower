import { DEFAULT_SHIFT_DEFINITIONS } from '@watchtower/shared';
import { sql } from 'drizzle-orm';

import { shiftDefinition } from '../schema/shifts.js';
import type { SeedExecutor } from './reference.js';

export interface ShiftSeedResult {
  readonly created: string[];
  readonly existing: string[];
}

/**
 * Creates the starter shifts of owner decision po #7: 08:00 to 17:00, 13:00 to 22:00 and an on-call
 * 22:00 to 08:00 (local time of the default business calendar). A shift whose name exists is left
 * alone, so edits made in a running instance survive a re-seed.
 */
export async function seedShiftDefinitions(executor: SeedExecutor): Promise<ShiftSeedResult> {
  const created: string[] = [];
  const existing: string[] = [];
  for (const definition of DEFAULT_SHIFT_DEFINITIONS) {
    const [found] = await executor
      .select({ id: shiftDefinition.id })
      .from(shiftDefinition)
      .where(sql`lower(${shiftDefinition.name}) = lower(${definition.name})`)
      .limit(1);
    if (found) {
      existing.push(definition.name);
      continue;
    }
    await executor.insert(shiftDefinition).values({
      name: definition.name,
      startsAt: definition.startsAt,
      endsAt: definition.endsAt,
      onCall: definition.onCall,
    });
    created.push(definition.name);
  }
  return { created, existing };
}
