import { schema } from '@watchtower/db';
import { INCIDENTS_AUDIT_ACTIONS, deployEventSchema, type DeployEvent } from '@watchtower/shared';
import { and, eq, ne } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { badRequest, notFound } from '../errors.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import { addTimelineEntry } from './timeline.js';

/**
 * Records one deploy from the feed (R-5.4). The service is a catalog slug (an unknown one is
 * `not_found`: a pipeline pointing at a service nobody catalogued should hear about it). The same
 * `(source, id)` is one deploy however often it is delivered: a redelivery changes nothing and returns
 * `recorded: false`. A deploy of a service that has an open incident is also noted on its timeline.
 * The times are the sender's, kept for display; the row also stores when we heard (database clock).
 */
export async function recordDeploy(
  tx: DbTransaction,
  ctx: DomainContext,
  input: DeployEvent,
): Promise<DomainResult<{ readonly recorded: boolean; readonly deployId: string | null }>> {
  const fx = new Effects();
  const parsed = deployEventSchema.safeParse(input);
  if (!parsed.success) throw badRequest('The deploy event is not valid');
  const event = parsed.data;
  const [service] = await tx
    .select({ id: schema.service.id, slug: schema.service.slug })
    .from(schema.service)
    .where(eq(schema.service.slug, event.service))
    .limit(1);
  if (service === undefined) throw notFound('No such service');

  const [created] = await tx
    .insert(schema.deploy)
    .values({
      serviceId: service.id,
      serviceSlug: service.slug,
      version: event.version,
      env: event.env,
      actor: event.actor,
      source: event.source,
      externalId: event.id,
      startedAt: event.startedAt === null ? null : new Date(event.startedAt),
      finishedAt: event.finishedAt === null ? null : new Date(event.finishedAt),
      url: event.url,
    })
    .onConflictDoNothing({ target: [schema.deploy.source, schema.deploy.externalId] })
    .returning({ id: schema.deploy.id });
  if (created === undefined) return fx.result({ recorded: false, deployId: null });

  const open = await tx
    .select({ id: schema.incident.id })
    .from(schema.incidentService)
    .innerJoin(schema.incident, eq(schema.incident.id, schema.incidentService.incidentId))
    .where(
      and(eq(schema.incidentService.serviceId, service.id), ne(schema.incident.status, 'resolved')),
    );
  for (const incident of open) {
    await addTimelineEntry(tx, ctx, incident.id, 'deploy_noted', {
      deployId: created.id,
      service: service.slug,
      env: event.env,
    });
  }
  await recordAuditInTx(tx, ctx, fx, {
    action: INCIDENTS_AUDIT_ACTIONS.deployRecord,
    targetType: 'deploy',
    targetId: created.id,
    metadata: { service: service.slug, env: event.env, source: event.source },
  });
  return fx.result({ recorded: true, deployId: created.id });
}
