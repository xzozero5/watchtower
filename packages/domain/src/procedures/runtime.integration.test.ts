import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  PROCEDURE_REQUIRE_HUMAN_TAG,
  PROCEDURE_TICKET_EVENTS,
  type ProcedureSimulationMetrics,
  type ProcedureSteps,
} from '@watchtower/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addIntent,
  addOrg,
  addStaff,
  auditRows,
  startDomainTest,
  type DomainTestEnv,
} from '../testing/support.js';
import {
  readProcedureSimulation,
  readPublishedProcedure,
  readSimulationTarget,
  readSimulationTickets,
  recordProcedureOutcome,
  recordProcedureSimulation,
  ticketRequiresHuman,
} from './runtime.js';

let env: DomainTestEnv;
let lead: Awaited<ReturnType<typeof addStaff>>;
let head: Awaited<ReturnType<typeof addStaff>>;
let orgId: string;

beforeAll(async () => {
  env = await startDomainTest();
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
  baseline: { editDistance: 22, uncitedClaims: 0, drafted: 3 },
  baselineVersionId: null,
  deadSteps: [],
  toolCalls: 6,
  failReasons: [],
  cases: [],
};

/** An intent with a confirmed version of STEPS. */
async function confirmedVersion() {
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
  const confirmed = (
    await env.tx((tx) =>
      env.domain.procedures.confirm(tx, ctx, { intentId: intent.id, versionId: draft.id }),
    )
  ).value;
  return { intent, version: confirmed };
}

async function resolvedTicket(
  intentId: string,
  over: { reply?: boolean; internalFirst?: boolean } = {},
) {
  const created = await env.tx((tx) =>
    env.domain.tickets.create(tx, env.ctx(lead.actor), {
      orgId,
      subject: 'Webhook not received',
      body: 'Our webhook is not received.',
      requester: { email: `${randomUUID()}@example.test`, name: 'Pat' },
    }),
  );
  const id = created.value.ticket.id;
  const owner = env.db.owner.db;
  await owner
    .update(schema.ticket)
    .set({ intentId, status: 'resolved', resolvedAt: new Date() })
    .where(eq(schema.ticket.id, id));
  if (over.internalFirst === true) {
    await owner.insert(schema.message).values({
      ticketId: id,
      direction: 'internal',
      senderUserId: lead.id,
      bodyText: 'Internal note before the reply.',
      visibility: 'internal',
    });
  }
  if (over.reply !== false) {
    await owner.insert(schema.message).values({
      ticketId: id,
      direction: 'outbound',
      senderUserId: lead.id,
      bodyText: 'Please check that the endpoint answers within ten seconds.',
      visibility: 'public',
      createdAt: new Date(Date.now() + 1000),
    });
  }
  return id;
}

describe('readPublishedProcedure', () => {
  it('is null until a version is published, then the steps of that version', async () => {
    const { intent, version } = await confirmedVersion();
    expect(await readPublishedProcedure(env.database.db, intent.id)).toBeNull();
    await recordProcedureSimulation(env.database.db, {
      versionId: version.id,
      passed: true,
      seedOnly: false,
      caseCount: 3,
      metrics: METRICS,
      ranBy: lead.id,
    });
    await env.tx((tx) =>
      env.domain.procedures.publish(tx, env.ctx(head.actor), {
        intentId: intent.id,
        versionId: version.id,
      }),
    );
    const live = await readPublishedProcedure(env.database.db, intent.id);
    expect(live?.versionId).toBe(version.id);
    expect(live?.steps).toEqual(STEPS);
  });
});

describe('simulation (T-303d)', () => {
  it('writes the row, moves the version to simulated and audits it; a failed run keeps it confirmed', async () => {
    const { intent, version } = await confirmedVersion();
    const failed = await recordProcedureSimulation(env.database.db, {
      versionId: version.id,
      passed: false,
      seedOnly: false,
      caseCount: 3,
      metrics: { ...METRICS, failReasons: ['policy_violation'] },
      ranBy: lead.id,
    });
    const afterFail = await env.tx((tx) =>
      env.domain.procedures.readVersion(tx, intent.id, version.id),
    );
    expect(afterFail.status).toBe('confirmed');
    expect(afterFail.simulation?.id).toBe(failed.id);

    const passed = await recordProcedureSimulation(env.database.db, {
      versionId: version.id,
      passed: true,
      seedOnly: false,
      caseCount: 3,
      metrics: METRICS,
      ranBy: lead.id,
    });
    const afterPass = await env.tx((tx) =>
      env.domain.procedures.readVersion(tx, intent.id, version.id),
    );
    expect(afterPass.status).toBe('simulated');
    expect(afterPass.simulation).toMatchObject({ id: passed.id, passed: true });

    const answer = await readProcedureSimulation(env.database.db, intent.id, version.id);
    expect(answer).toMatchObject({ id: passed.id, passed: true, stepsHash: version.stepsHash });
    expect(answer?.metrics.candidate.editDistance).toBe(20);

    const audits = (await auditRows(env, AUDIT_ACTIONS.procedureSimulated)).filter(
      (row) => row.targetId === version.id,
    );
    expect(audits.map((row) => row.outcome).sort()).toEqual(['failure', 'success']);
    // Ids and counts only.
    expect(JSON.stringify(audits[0]?.metadata)).not.toContain('Webhook');
  });

  it('refuses to simulate a draft (the database says so)', async () => {
    const intent = await addIntent(env, { allowedTools: [] });
    const draft = (
      await env.tx((tx) =>
        env.domain.procedures.createDraft(tx, env.ctx(lead.actor), {
          intentId: intent.id,
          sourceMd: 'x',
        }),
      )
    ).value;
    await expect(
      recordProcedureSimulation(env.database.db, {
        versionId: draft.id,
        passed: true,
        seedOnly: false,
        caseCount: 1,
        metrics: METRICS,
        ranBy: null,
      }),
    ).rejects.toThrow();
  });

  it('reads the target with its baseline: the live version, or none when it is the live one itself', async () => {
    const { intent, version } = await confirmedVersion();
    const target = await readSimulationTarget(env.database.db, version.id);
    expect(target).toMatchObject({ intentId: intent.id, versionId: version.id, baseline: null });
    expect(target?.steps).toEqual(STEPS);
    expect(await readSimulationTarget(env.database.db, randomUUID())).toBeNull();
  });

  it('replays resolved tickets of the intent that have a customer message and a reply of a person, cut at the first reply', async () => {
    const intent = await addIntent(env, { allowedTools: [] });
    const withReply = await resolvedTicket(intent.id, { internalFirst: true });
    await resolvedTicket(intent.id, { reply: false });
    const other = await addIntent(env, { allowedTools: [] });
    await resolvedTicket(other.id);

    const tickets = await readSimulationTickets(env.database.db, {
      intentId: intent.id,
      limit: 30,
    });
    expect(tickets.map((ticket) => ticket.id)).toEqual([withReply]);
    const [ticket] = tickets;
    expect(ticket?.humanReply).toBe('Please check that the endpoint answers within ten seconds.');
    expect(ticket?.seeded).toBe(false);
    // The internal note came before the reply and is kept for the redaction layer to treat as a note; the reply itself is not.
    expect(ticket?.messages.map((message) => message.visibility)).toEqual(['public', 'internal']);
    expect(ticket?.messages.some((message) => message.text.includes('ten seconds'))).toBe(false);
  });

  it('leaves out a seed batch while the column exists, and fills up with it (marked) only when real tickets are too few', async () => {
    // ticket.seed_batch_id exists since 0096 and only the schema owner writes it (a seed ticket lives in an
    // organization of the same batch). The seed_batch row stays behind: the table is append-only.
    const owner = env.db.owner.db;
    const intent = await addIntent(env, { allowedTools: [] });
    const real = await resolvedTicket(intent.id);
    const seeded = await resolvedTicket(intent.id);
    const batch = await owner.execute<{ id: string }>(
      sql`INSERT INTO seed_batch (kind, note) VALUES ('demo', 'T-303d simulation test') RETURNING id`,
    );
    const batchId = batch.rows[0]?.id;
    if (batchId === undefined) throw new Error('seed_batch insert returned no row');
    const seedOrg = await owner.execute<{ id: string }>(
      sql`INSERT INTO organization (name, seed_batch_id) VALUES ('Seed org', ${batchId}::uuid) RETURNING id`,
    );
    const seedOrgId = seedOrg.rows[0]?.id;
    if (seedOrgId === undefined) throw new Error('organization insert returned no row');
    await owner.execute(
      sql`UPDATE ticket SET org_id = ${seedOrgId}::uuid, seed_batch_id = ${batchId}::uuid WHERE id = ${seeded}`,
    );
    const enough = await readSimulationTickets(env.database.db, {
      intentId: intent.id,
      limit: 1,
    });
    expect(enough.map((ticket) => [ticket.id, ticket.seeded])).toEqual([[real, false]]);
    const filled = await readSimulationTickets(env.database.db, {
      intentId: intent.id,
      limit: 5,
    });
    expect(filled.map((ticket) => [ticket.id, ticket.seeded]).sort()).toEqual(
      [
        [real, false],
        [seeded, true],
      ].sort(),
    );
  });
});

describe('recordProcedureOutcome', () => {
  it('leaves an escalation proposal and a call for a person once per step and version, and tags the ticket', async () => {
    const { version } = await confirmedVersion();
    const intent = await addIntent(env, { allowedTools: [] });
    const ticketId = await resolvedTicket(intent.id);
    const input = {
      ticketId,
      versionId: version.id,
      escalations: [{ stepId: 'e1', to: { role: 'lead' as const }, priority: 'P2', note: 'Look.' }],
      requireHuman: [{ stepId: 'h1', reason: 'No cause found' }],
    };
    expect(await ticketRequiresHuman(env.database.db, ticketId)).toBe(false);
    expect(await recordProcedureOutcome(env.database.db, input)).toEqual({
      proposed: ['e1'],
      requiredHuman: ['h1'],
    });
    // A second investigation does not pile up cards.
    expect(await recordProcedureOutcome(env.database.db, input)).toEqual({
      proposed: [],
      requiredHuman: [],
    });
    const events = await env.db.owner.db
      .select()
      .from(schema.ticketEvent)
      .where(eq(schema.ticketEvent.ticketId, ticketId));
    const mine = events.filter((event) => event.type.startsWith('procedure.'));
    expect(mine.map((event) => event.type).sort()).toEqual([
      PROCEDURE_TICKET_EVENTS.procedureEscalationProposed,
      PROCEDURE_TICKET_EVENTS.procedureRequireHuman,
    ]);
    expect(mine.every((event) => event.actorType === 'ai' && event.visibility === 'internal')).toBe(
      true,
    );
    expect(await ticketRequiresHuman(env.database.db, ticketId)).toBe(true);
    const [row] = await env.db.owner.db
      .select({ tags: schema.ticket.tags })
      .from(schema.ticket)
      .where(eq(schema.ticket.id, ticketId));
    expect(row?.tags.filter((tag) => tag === PROCEDURE_REQUIRE_HUMAN_TAG)).toHaveLength(1);
  });
});
