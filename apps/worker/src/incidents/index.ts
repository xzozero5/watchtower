import { discord } from '@watchtower/channels';
import { schema } from '@watchtower/db';
import { addTimelineEntry } from '@watchtower/domain';
import {
  INCIDENTS_JOBS,
  formatIncidentKey,
  incidentMirrorJobSchema,
  incidentThreadJobSchema,
  incidentSeveritySchema,
  incidentStatusSchema,
  type IncidentMirrorJob,
  type IncidentThreadJob,
  type IncidentTimelineType,
} from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import { and, asc, eq } from 'drizzle-orm';

import { FAKE_CHANNEL_ID, createBotRuntime, type BotRuntime } from '../alerts/bot.js';
import type { WorkerLogger } from '../logger.js';
import type { ProcessorContext } from '../processors/index.js';

/** What a test replaces; production passes none. */
export interface IncidentsOverrides {
  /** The bot transport. Default: the in-memory fake (this build has no live bot). */
  readonly bot?: discord.BotTransport;
}

export type ThreadOutcome = 'missing' | 'already' | 'created' | 'mock';
export type MirrorOutcome = 'missing' | 'dropped' | 'mirrored';

interface Deps {
  readonly context: ProcessorContext;
  readonly runtime: BotRuntime;
  readonly logger: WorkerLogger;
}

/**
 * Creates the Discord thread of an incident (R-3.13) and records how it went on the incident row.
 *
 * `created` only when the transport reports a real thread (`delivered: true` with an id); the in-memory
 * fake yields `mock`, and the table refuses ids on a mock row. The row is locked for the whole call, so
 * two workers never create two threads. A transport failure rolls everything back and throws: the job is
 * retried by BullMQ with backoff. The thread's name and opening message hold the incident number, the
 * severity and status, and service slugs only (N4): never the title.
 */
export async function createThread(deps: Deps, job: IncidentThreadJob): Promise<ThreadOutcome> {
  const { context, runtime } = deps;
  const { database, domain, config } = context;
  const channel = (await runtime.channelId()) ?? FAKE_CHANNEL_ID;
  return database.db.transaction(async (tx) => {
    const [incident] = await tx
      .select()
      .from(schema.incident)
      .where(eq(schema.incident.id, job.incidentId))
      .for('update');
    if (incident === undefined) return 'missing';
    if (incident.discordThreadState !== 'pending') return 'already';

    const services = await tx
      .select({ slug: schema.service.slug })
      .from(schema.incidentService)
      .innerJoin(schema.service, eq(schema.service.id, schema.incidentService.serviceId))
      .where(eq(schema.incidentService.incidentId, incident.id))
      .orderBy(asc(schema.service.slug));
    const facts = {
      incidentId: incident.id,
      key: formatIncidentKey(incident.number),
      severity: incidentSeveritySchema.parse(incident.severity),
      status: incidentStatusSchema.parse(incident.status),
      serviceSlugs: services.map((service) => service.slug),
      link: new URL(`/incidents/${incident.id}`, config.APP_URL).toString(),
    };
    const opening = await runtime.transport.postMessage(
      channel,
      discord.buildIncidentOpeningMessage(facts),
    );
    const thread = await runtime.transport.createThread(
      channel,
      opening.messageId ?? FAKE_CHANNEL_ID,
      discord.incidentThreadName(facts),
    );
    const real = opening.delivered && thread.delivered && thread.threadId !== null;
    await tx
      .update(schema.incident)
      .set(
        real
          ? {
              discordThreadState: 'created',
              discordChannelId: thread.channelId ?? channel,
              discordThreadId: thread.threadId,
            }
          : { discordThreadState: 'mock' },
      )
      .where(eq(schema.incident.id, incident.id));
    await addTimelineEntry(
      tx,
      domain.context({ actor: { type: 'system', id: null } }),
      incident.id,
      'thread_created',
      { state: real ? 'created' : 'mock' },
    );
    return real ? 'created' : 'mock';
  });
}

/**
 * Mirrors one key timeline entry into the thread (R-3.13). The line is built from the entry's type and
 * its enumerations by `buildIncidentMirrorLine`: a note's text and anything else is not in it. If the
 * thread does not exist yet the job throws and BullMQ retries it later; a thread that was skipped or
 * failed drops the line.
 */
export async function mirrorEntry(deps: Deps, job: IncidentMirrorJob): Promise<MirrorOutcome> {
  const { database } = deps.context;
  const [row] = await database.db
    .select({
      number: schema.incident.number,
      state: schema.incident.discordThreadState,
      threadId: schema.incident.discordThreadId,
      type: schema.incidentTimeline.type,
      payload: schema.incidentTimeline.payload,
    })
    .from(schema.incidentTimeline)
    .innerJoin(schema.incident, eq(schema.incident.id, schema.incidentTimeline.incidentId))
    .where(
      and(
        eq(schema.incidentTimeline.id, job.timelineId),
        eq(schema.incidentTimeline.incidentId, job.incidentId),
      ),
    )
    .limit(1);
  if (row === undefined) return 'missing';
  if (row.state === 'pending') throw new Error('the incident thread is not created yet');
  if (row.state === 'skipped' || row.state === 'failed') return 'dropped';
  const line = discord.buildIncidentMirrorLine(
    row.type as IncidentTimelineType,
    row.payload,
    formatIncidentKey(row.number),
  );
  // A mock thread has no id: the fake gets a stable name so a test can see which incident it was for.
  await deps.runtime.transport.postInThread(row.threadId ?? `mock-thread-${job.incidentId}`, line);
  return 'mirrored';
}

/** Wires the `incidents` consumer (T-202b): the thread of a new incident and the mirrored timeline lines. */
export function createIncidentsRegistration(context: ProcessorContext) {
  const runtime = createBotRuntime(context, context.overrides.incidents?.bot);
  const deps: Deps = { context, runtime, logger: context.logger };
  return async (job: Job): Promise<unknown> => {
    switch (job.name) {
      case INCIDENTS_JOBS.thread: {
        const parsed = incidentThreadJobSchema.safeParse(job.data);
        if (!parsed.success) throw new UnrecoverableError('incident thread payload is invalid');
        return createThread(deps, parsed.data);
      }
      case INCIDENTS_JOBS.mirror: {
        const parsed = incidentMirrorJobSchema.safeParse(job.data);
        if (!parsed.success) throw new UnrecoverableError('incident mirror payload is invalid');
        return mirrorEntry(deps, parsed.data);
      }
      default:
        throw new UnrecoverableError(`unknown incidents job "${job.name}"`);
    }
  };
}
