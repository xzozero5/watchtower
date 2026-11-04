import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  PROCEDURE_TICKET_EVENTS,
  type ProcedureSimulationMetrics,
  type ProcedureSteps,
} from '@watchtower/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addIntent,
  addOrg,
  addQueue,
  addStaff,
  auditRows,
  startDomainTest,
  type DomainTestEnv,
} from '../testing/support.js';
import { applyProcedureEscalation, readProcedureProposals } from './escalation.js';
import { recordProcedureOutcome, recordProcedureSimulation } from './runtime.js';

let env: DomainTestEnv;
let agent: Awaited<ReturnType<typeof addStaff>>;
let lead: Awaited<ReturnType<typeof addStaff>>;
let head: Awaited<ReturnType<typeof addStaff>>;
let orgId: string;

beforeAll(async () => {
  env = await startDomainTest();
  agent = await addStaff(env, 'agent');
  lead = await addStaff(env, 'lead');
  head = await addStaff(env, 'head');
  orgId = (await addOrg(env)).id;
});
afterAll(async () => {
  await env.close();
});

const STEPS: ProcedureSteps = {
  schemaVersion: 1,
  autosend: 'never',
  steps: [{ kind: 'tool', id: 'kb', tool: 'kb_search' }],
};
const METRICS: ProcedureSimulationMetrics = {
  mode: 'instance',
  caseCount: 3,
  failedCases: 0,
  seededCases: 0,
  candidate: { editDistance: 20, uncitedClaims: 0, drafted: 3, violations: 0, disclosureLeaks: 0 },
  baseline: null,
  baselineVersionId: null,
  deadSteps: [],
  toolCalls: 3,
  failReasons: [],
  cases: [],
};

/** An intent with a published version, and an open ticket of it holding one escalation card. */
async function cardOn(
  to: { queueKey: string } | { role: 'lead' | 'head' },
  priority?: 'P1' | 'P2' | 'P3' | 'P4',
) {
  const intent = await addIntent(env, { allowedTools: [] });
  const ctx = env.ctx(lead.actor);
  const draft = (
    await env.tx((tx) =>
      env.domain.procedures.createDraft(tx, ctx, {
        intentId: intent.id,
        sourceMd: 'x',
        steps: STEPS,
      }),
    )
  ).value;
  await env.tx((tx) =>
    env.domain.procedures.confirm(tx, ctx, { intentId: intent.id, versionId: draft.id }),
  );
  await recordProcedureSimulation(env.database.db, {
    versionId: draft.id,
    passed: true,
    seedOnly: false,
    caseCount: 3,
    metrics: METRICS,
    ranBy: lead.id,
  });
  await env.tx((tx) =>
    env.domain.procedures.publish(tx, env.ctx(head.actor), {
      intentId: intent.id,
      versionId: draft.id,
    }),
  );
  const created = await env.tx((tx) =>
    env.domain.tickets.create(tx, env.ctx(lead.actor), {
      orgId,
      subject: 'Webhook not received',
      body: 'Our webhook is not received.',
      requester: { email: `${randomUUID()}@example.test`, name: 'Pat' },
    }),
  );
  const ticketId = created.value.ticket.id;
  await env.db.owner.db
    .update(schema.ticket)
    .set({ intentId: intent.id, assigneeId: agent.id })
    .where(eq(schema.ticket.id, ticketId));
  await recordProcedureOutcome(env.database.db, {
    ticketId,
    versionId: draft.id,
    escalations: [
      { stepId: 'e1', to, ...(priority === undefined ? {} : { priority }), note: 'Look.' },
    ],
    requireHuman: [],
  });
  const [card] = await readProcedureProposals(env.database.db, ticketId);
  if (card === undefined) throw new Error('no card');
  return { intent, ticketId, card, versionId: draft.id };
}

const press = (ticketId: string, proposalId: string, actor = agent.actor) =>
  env.tx((tx) => applyProcedureEscalation(tx, env.ctx(actor), { ref: ticketId, proposalId }));

describe('escalation cards (T-303f)', () => {
  it('moves the ticket to the queue, keeps the assignee, sets the priority and audits via=procedure', async () => {
    const queue = await addQueue(env);
    const { ticketId, card } = await cardOn({ queueKey: queue.name.toUpperCase() }, 'P2');
    expect(card).toMatchObject({ status: 'pending', priority: 'P2' });

    const result = (await press(ticketId, card.id)).value;
    expect(result).toMatchObject({ alreadyApplied: false, action: 'moved_queue', priority: 'P2' });
    const [row] = await env.db.owner.db
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.id, ticketId));
    expect(row?.queueId).toBe(queue.id);
    expect(row?.assigneeId).toBe(agent.id);
    expect(row?.priority).toBe('P2');
    const audit = (await auditRows(env, AUDIT_ACTIONS.procedureEscalationApplied)).filter(
      (entry) => entry.targetId === ticketId,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: agent.id });
    expect(audit[0]?.metadata).toMatchObject({ via: 'procedure', proposalId: card.id });
    const [after] = await readProcedureProposals(env.database.db, ticketId);
    expect(after).toMatchObject({ status: 'applied' });
  });

  it('is idempotent: a second press changes and writes nothing more', async () => {
    const queue = await addQueue(env);
    const { ticketId, card } = await cardOn({ queueKey: queue.name });
    await press(ticketId, card.id);
    const again = (await press(ticketId, card.id)).value;
    expect(again).toMatchObject({ alreadyApplied: true, action: 'moved_queue' });
    const audit = (await auditRows(env, AUDIT_ACTIONS.procedureEscalationApplied)).filter(
      (entry) => entry.targetId === ticketId,
    );
    expect(audit).toHaveLength(1);
    const events = await env.db.owner.db
      .select()
      .from(schema.ticketEvent)
      .where(eq(schema.ticketEvent.ticketId, ticketId));
    expect(
      events.filter((e) => e.type === PROCEDURE_TICKET_EVENTS.procedureEscalationApplied),
    ).toHaveLength(1);
  });

  it('role target: tells the leads on shift (all of the role when none), leaves an internal note, assigns nobody', async () => {
    const { ticketId, card } = await cardOn({ role: 'lead' });
    const result = (await press(ticketId, card.id)).value;
    expect(result).toMatchObject({ action: 'asked_role' });
    expect(result.notified).toBeGreaterThanOrEqual(1);
    const notes = await env.db.owner.db
      .select()
      .from(schema.notification)
      .where(eq(schema.notification.ticketId, ticketId));
    expect(notes.length).toBe(result.notified);
    expect(
      notes.every((n) => n.kind === 'ticket.escalation_requested' && n.severity === 'high'),
    ).toBe(true);
    expect(notes.some((n) => n.userId === lead.id)).toBe(true);
    const messages = await env.db.owner.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.ticketId, ticketId));
    const internal = messages.filter((m) => m.direction === 'internal');
    expect(internal).toHaveLength(1);
    expect(internal[0]?.bodyText).toContain('Look.');
    const [row] = await env.db.owner.db
      .select({ assigneeId: schema.ticket.assigneeId })
      .from(schema.ticket)
      .where(eq(schema.ticket.id, ticketId));
    expect(row?.assigneeId).toBe(agent.id);
  });

  it('role target with a lead on shift: only the lead on shift is told', async () => {
    const onShift = await addStaff(env, 'head');
    await addStaff(env, 'head');
    await env.db.owner.db.insert(schema.shiftSession).values({ userId: onShift.id });
    const { ticketId, card } = await cardOn({ role: 'head' });
    await press(ticketId, card.id);
    const told = await env.db.owner.db
      .select({ userId: schema.notification.userId })
      .from(schema.notification)
      .where(eq(schema.notification.ticketId, ticketId));
    expect(told.map((row) => row.userId)).toEqual([onShift.id]);
  });

  it('expires when the ticket is closed or the procedure moved on, and refuses to run it', async () => {
    const closed = await cardOn({ role: 'lead' });
    await env.db.owner.db
      .update(schema.ticket)
      .set({ status: 'closed' })
      .where(eq(schema.ticket.id, closed.ticketId));
    expect((await readProcedureProposals(env.database.db, closed.ticketId))[0]).toMatchObject({
      status: 'expired',
      expiredReason: 'ticket_closed',
    });
    await expect(press(closed.ticketId, closed.card.id)).rejects.toMatchObject({
      code: 'conflict',
    });

    const moved = await cardOn({ role: 'lead' });
    await env.db.owner.db
      .update(schema.intent)
      .set({ procedureVersionId: null })
      .where(eq(schema.intent.id, moved.intent.id));
    expect((await readProcedureProposals(env.database.db, moved.ticketId))[0]).toMatchObject({
      status: 'expired',
      expiredReason: 'version_changed',
    });
    await expect(press(moved.ticketId, moved.card.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('404 for a card that is not on this ticket', async () => {
    const a = await cardOn({ role: 'lead' });
    const b = await cardOn({ role: 'lead' });
    await expect(press(a.ticketId, b.card.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});
