import { schema } from '@watchtower/db';
import {
  INCIDENTS_JOBS,
  INCIDENTS_OUTBOX_JOB_OPTIONS,
  MIRRORED_TIMELINE_TYPES,
  QUEUE_NAMES,
  type IncidentTimelineType,
} from '@watchtower/shared';

import { enqueueJob } from '../outbox.js';
import type { DbTransaction, DomainContext } from '../types.js';

/**
 * Appends one entry to an incident's timeline, with the database clock, in the caller's transaction.
 * The payload holds ids, enumerations and counts; the one free-text type is `note`, internal. When the
 * entry is one of the key types (`MIRRORED_TIMELINE_TYPES`) a mirror job is queued through the
 * transactional outbox, so the line reaches the Discord thread if and only if the entry committed.
 * Returns the entry id.
 */
export async function addTimelineEntry(
  tx: DbTransaction,
  ctx: DomainContext,
  incidentId: string,
  type: IncidentTimelineType,
  payload: Record<string, unknown> = {},
): Promise<string> {
  const [row] = await tx
    .insert(schema.incidentTimeline)
    .values({
      incidentId,
      type,
      actorType: ctx.actor.type === 'anonymous' ? 'anonymous' : ctx.actor.type,
      actorId: ctx.actor.id,
      payload,
    })
    .returning({ id: schema.incidentTimeline.id });
  if (row === undefined) throw new Error('incident_timeline insert returned no row');
  if ((MIRRORED_TIMELINE_TYPES as readonly string[]).includes(type)) {
    await enqueueJob(tx, ctx.config, {
      queue: QUEUE_NAMES.incidents,
      name: INCIDENTS_JOBS.mirror,
      jobId: `incident-mirror-${row.id}`,
      payload: { incidentId, timelineId: row.id },
      options: INCIDENTS_OUTBOX_JOB_OPTIONS,
    });
  }
  return row.id;
}
