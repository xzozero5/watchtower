import { schema } from '@watchtower/db';
import {
  QUEUE_NAMES,
  STATUSPAGE_AUDIT_ACTIONS,
  STATUSPAGE_JOBS,
  createStatusPostSchema,
  draftFromIncidentSchema,
  statusPostTemplate,
  updateStatusPostSchema,
  type CreateStatusPost,
  type DraftFromIncident,
  type UpdateStatusPost,
} from '@watchtower/shared';
import { eq, inArray, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { DomainError, badRequest, conflict, notFound } from '../errors.js';
import { enqueueJob } from '../outbox.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import { assertComponentsExist, requirePerson } from './components.js';

/** A draft may be written by a person or by the AI; the system and an anonymous caller have nobody to answer for the words. */
function drafterOrigin(ctx: DomainContext): 'human' | 'ai' {
  if (ctx.actor.type === 'user' && ctx.actor.id !== null) return 'human';
  if (ctx.actor.type === 'ai') return 'ai';
  throw new DomainError('policy_denied', 'Only a person or the AI can draft a status post', {
    reason: 'drafter_required',
  });
}

const NOTIFY_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/**
 * Writes a draft (R-6.3). A draft is invisible to the public page and tells nobody. The text is the
 * drafter's; an incident, when named, is only a link for staff (nothing of it is copied or exposed).
 */
export async function draftStatusPost(
  tx: DbTransaction,
  ctx: DomainContext,
  input: CreateStatusPost,
): Promise<DomainResult<{ readonly id: string }>> {
  const fx = new Effects();
  const origin = drafterOrigin(ctx);
  const parsed = createStatusPostSchema.safeParse(input);
  if (!parsed.success) throw badRequest('The post is not valid');
  const data = parsed.data;
  if (data.incidentId !== null) {
    const [incident] = await tx
      .select({ id: schema.incident.id })
      .from(schema.incident)
      .where(eq(schema.incident.id, data.incidentId))
      .limit(1);
    if (incident === undefined) throw badRequest('incidentId does not name an incident');
  }
  const componentIds = await assertComponentsExist(tx, data.componentIds);
  const [post] = await tx
    .insert(schema.statusPost)
    .values({
      incidentId: data.incidentId,
      title: data.title,
      body: data.body,
      phase: data.phase,
      impact: data.impact,
      origin,
      draftedBy: ctx.actor.type === 'user' ? ctx.actor.id : null,
    })
    .returning({ id: schema.statusPost.id });
  if (post === undefined) throw new Error('status_post insert returned no row');
  if (componentIds.length > 0) {
    await tx
      .insert(schema.statusPostComponent)
      .values(componentIds.map((componentId) => ({ postId: post.id, componentId })));
  }
  await recordAuditInTx(tx, ctx, fx, {
    action: STATUSPAGE_AUDIT_ACTIONS.postDraft,
    targetType: 'status_post',
    targetId: post.id,
    metadata: { origin, incidentId: data.incidentId, components: componentIds.length },
  });
  return fx.result({ id: post.id });
}

/**
 * A draft for an incident, from the template of the phase: the words name the components and nothing
 * else, so no internal detail of the incident can reach a draft by this route. A person then edits it.
 */
export async function draftStatusPostFromIncident(
  tx: DbTransaction,
  ctx: DomainContext,
  input: DraftFromIncident,
): Promise<DomainResult<{ readonly id: string }>> {
  drafterOrigin(ctx);
  const parsed = draftFromIncidentSchema.safeParse(input);
  if (!parsed.success) throw badRequest('The request is not valid');
  const componentIds = await assertComponentsExist(tx, parsed.data.componentIds);
  const names = await tx
    .select({ name: schema.statusComponent.name })
    .from(schema.statusComponent)
    .where(inArray(schema.statusComponent.id, componentIds))
    .orderBy(schema.statusComponent.position, schema.statusComponent.name);
  const wording = statusPostTemplate({
    phase: parsed.data.phase,
    locale: parsed.data.locale,
    componentNames: names.map((row) => row.name),
  });
  return draftStatusPost(tx, ctx, {
    title: wording.title,
    body: wording.body,
    phase: parsed.data.phase,
    impact: parsed.data.impact,
    componentIds,
    incidentId: parsed.data.incidentId,
  });
}

/**
 * Changes a post. A draft may be edited by a person or the AI; once it is public only a person edits it
 * (the page changes the moment this commits, so it is the same decision as publishing).
 */
export async function updateStatusPost(
  tx: DbTransaction,
  ctx: DomainContext,
  id: string,
  input: UpdateStatusPost,
): Promise<DomainResult<{ readonly id: string }>> {
  const fx = new Effects();
  drafterOrigin(ctx);
  const parsed = updateStatusPostSchema.safeParse(input);
  if (!parsed.success) throw badRequest('The change is not valid');
  const [post] = await tx
    .select()
    .from(schema.statusPost)
    .where(eq(schema.statusPost.id, id))
    .for('update')
    .limit(1);
  if (post === undefined) throw notFound('No such post');
  if (post.state === 'published') requirePerson(ctx, 'change a published status post');
  const { componentIds, ...columns } = parsed.data;
  if (Object.keys(columns).length > 0) {
    await tx
      .update(schema.statusPost)
      .set({ ...columns, updatedAt: sql`clock_timestamp()` })
      .where(eq(schema.statusPost.id, id));
  }
  if (componentIds !== undefined) {
    const unique = await assertComponentsExist(tx, componentIds);
    await tx.delete(schema.statusPostComponent).where(eq(schema.statusPostComponent.postId, id));
    if (unique.length > 0) {
      await tx
        .insert(schema.statusPostComponent)
        .values(unique.map((componentId) => ({ postId: id, componentId })));
    }
    await tx
      .update(schema.statusPost)
      .set({ updatedAt: sql`clock_timestamp()` })
      .where(eq(schema.statusPost.id, id));
  }
  await recordAuditInTx(tx, ctx, fx, {
    action: STATUSPAGE_AUDIT_ACTIONS.postUpdate,
    targetType: 'status_post',
    targetId: id,
    metadata: { fields: Object.keys(parsed.data), published: post.state === 'published' },
  });
  return fx.result({ id });
}

/**
 * Publishes a post (N3). **A person presses.** The actor must be a signed-in user; the AI and the system
 * are refused whoever drafted the text, and the table refuses a published post without the person and the
 * time. The subscribers are told after the commit, by the worker, once (the job id is the post).
 */
export async function publishStatusPost(
  tx: DbTransaction,
  ctx: DomainContext,
  id: string,
): Promise<DomainResult<{ readonly subscribers: number }>> {
  const fx = new Effects();
  const personId = requirePerson(ctx, 'publish a status post');
  const [post] = await tx
    .select({ state: schema.statusPost.state })
    .from(schema.statusPost)
    .where(eq(schema.statusPost.id, id))
    .for('update')
    .limit(1);
  if (post === undefined) throw notFound('No such post');
  if (post.state === 'published') throw conflict('This post is already published');
  await tx
    .update(schema.statusPost)
    .set({
      state: 'published',
      publishedBy: personId,
      publishedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(schema.statusPost.id, id));
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.statusSubscription)
    .where(eq(schema.statusSubscription.state, 'confirmed'));
  const subscribers = count?.n ?? 0;
  await enqueueJob(tx, ctx.config, {
    queue: QUEUE_NAMES.statuspage,
    name: STATUSPAGE_JOBS.notify,
    jobId: `status-notify-post-${id}`,
    payload: { kind: 'post', refId: id },
    options: NOTIFY_OPTIONS,
  });
  await recordAuditInTx(tx, ctx, fx, {
    action: STATUSPAGE_AUDIT_ACTIONS.postPublish,
    targetType: 'status_post',
    targetId: id,
    metadata: { subscribers },
  });
  return fx.result({ subscribers });
}

/** Removes a draft. A published post stays: what the public saw is part of the record. */
export async function deleteStatusPostDraft(
  tx: DbTransaction,
  ctx: DomainContext,
  id: string,
): Promise<DomainResult<{ readonly deleted: boolean }>> {
  const fx = new Effects();
  drafterOrigin(ctx);
  const [post] = await tx
    .select({ state: schema.statusPost.state })
    .from(schema.statusPost)
    .where(eq(schema.statusPost.id, id))
    .for('update')
    .limit(1);
  if (post === undefined) return fx.result({ deleted: false });
  if (post.state === 'published') throw conflict('A published post cannot be deleted');
  await tx.delete(schema.statusPost).where(eq(schema.statusPost.id, id));
  await recordAuditInTx(tx, ctx, fx, {
    action: STATUSPAGE_AUDIT_ACTIONS.postDelete,
    targetType: 'status_post',
    targetId: id,
  });
  return fx.result({ deleted: true });
}
