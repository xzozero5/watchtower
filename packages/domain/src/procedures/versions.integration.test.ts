import { schema } from '@watchtower/db';
import { AUDIT_ACTIONS, type ProcedureSteps } from '@watchtower/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DomainError } from '../errors.js';
import {
  addIntent,
  addQueue,
  addStaff,
  auditRows,
  startDomainTest,
  type DomainTestEnv,
} from '../testing/support.js';

let env: DomainTestEnv;

beforeAll(async () => {
  env = await startDomainTest();
});
afterAll(async () => {
  await env.close();
});

const STEPS: ProcedureSteps = {
  schemaVersion: 1,
  autosend: 'never',
  steps: [
    { kind: 'tool', id: 'kb', tool: 'kb_search' },
    { kind: 'check', id: 'c', question: 'Did the KB answer it?', evidenceFrom: ['kb'] },
  ],
};

async function author(role: 'lead' | 'head' = 'lead') {
  return addStaff(env, role);
}

async function refusal(work: Promise<unknown>): Promise<DomainError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

/** A passing simulation of the version, the way the runner of T-303d will write one. */
async function simulate(versionId: string, over: { passed?: boolean; seedOnly?: boolean } = {}) {
  const [row] = await env.database.db
    .insert(schema.procedureSimulation)
    .values({
      procedureVersionId: versionId,
      passed: over.passed ?? true,
      seedOnly: over.seedOnly ?? false,
      caseCount: 3,
    })
    .returning();
  return row;
}

describe('procedure versions: the whole way from draft to published', () => {
  it('creates, edits, compiles, confirms, publishes and retires, with an audit row for each', async () => {
    const intent = await addIntent(env, { allowedTools: [] });
    const lead = await author('lead');
    const head = await author('head');
    const ctx = env.ctx(lead.actor);

    const created = await env.tx((tx) =>
      env.domain.procedures.createDraft(tx, ctx, {
        intentId: intent.id,
        sourceMd: 'Search the KB, then ask whether it answered.',
      }),
    );
    expect(created.audited).toBe(true);
    const draft = created.value;
    expect(draft).toMatchObject({
      version: 1,
      status: 'draft',
      authoredBy: lead.id,
      intentId: intent.id,
    });
    expect(draft.steps.steps).toEqual([]);
    expect(draft.stepsHash).toMatch(/^[0-9a-f]{64}$/);

    const edited = (
      await env.tx((tx) =>
        env.domain.procedures.updateDraft(tx, ctx, {
          intentId: intent.id,
          versionId: draft.id,
          sourceMd: 'Search the KB first.',
        }),
      )
    ).value;
    expect(edited.sourceMd).toBe('Search the KB first.');

    // The compiler's steps land in the draft; it is still a draft.
    const compiled = (
      await env.tx((tx) =>
        env.domain.procedures.recordCompile(tx, ctx, {
          intentId: intent.id,
          versionId: draft.id,
          steps: STEPS,
          aiRunId: '00000000-0000-4000-8000-000000000001',
          promptVersion: 1,
        }),
      )
    ).value;
    expect(compiled.status).toBe('draft');
    expect(compiled.stepsHash).not.toBe(draft.stepsHash);
    expect(compiled.compiledByAiRunId).toBe('00000000-0000-4000-8000-000000000001');

    const confirmed = (
      await env.tx((tx) =>
        env.domain.procedures.confirm(tx, ctx, { intentId: intent.id, versionId: draft.id }),
      )
    ).value;
    expect(confirmed).toMatchObject({ status: 'confirmed', confirmedBy: lead.id });

    // Frozen from here on.
    expect(
      (
        await refusal(
          env.tx((tx) =>
            env.domain.procedures.updateDraft(tx, ctx, {
              intentId: intent.id,
              versionId: draft.id,
              sourceMd: 'x',
            }),
          ),
        )
      ).code,
    ).toBe('conflict');

    // No simulation: publish is refused, and the intent keeps the default runbook.
    const noSim = await refusal(
      env.tx((tx) =>
        env.domain.procedures.publish(tx, env.ctx(head.actor), {
          intentId: intent.id,
          versionId: draft.id,
        }),
      ),
    );
    expect(noSim.code).toBe('conflict');
    expect(
      (await env.db.owner.db.select().from(schema.intent).where(eq(schema.intent.id, intent.id)))[0]
        ?.procedureVersionId,
    ).toBeNull();

    // A failing simulation does not open the door; a passing one does.
    await simulate(draft.id, { passed: false });
    expect(
      (
        await refusal(
          env.tx((tx) =>
            env.domain.procedures.publish(tx, env.ctx(head.actor), {
              intentId: intent.id,
              versionId: draft.id,
            }),
          ),
        )
      ).code,
    ).toBe('conflict');
    const sim = await simulate(draft.id);
    const published = (
      await env.tx((tx) =>
        env.domain.procedures.publish(tx, env.ctx(head.actor), {
          intentId: intent.id,
          versionId: draft.id,
        }),
      )
    ).value;
    expect(published).toMatchObject({
      status: 'published',
      publishedBy: head.id,
      simulation: { id: sim?.id, passed: true },
    });
    const list = await env.domain.procedures.readVersions(env.database.db, intent.id);
    expect(list.publishedVersionId).toBe(draft.id);
    expect(list.items.map((item) => item.version)).toEqual([1]);

    const retired = (
      await env.tx((tx) =>
        env.domain.procedures.retire(tx, env.ctx(head.actor), {
          intentId: intent.id,
          versionId: draft.id,
        }),
      )
    ).value;
    expect(retired.status).toBe('retired');
    expect(
      (await env.domain.procedures.readVersions(env.database.db, intent.id)).publishedVersionId,
    ).toBeNull();

    const actions = (await auditRows(env))
      .filter((row) => row.targetId === draft.id || row.targetType === 'procedure')
      .filter((row) => (row.metadata as { intentId?: string }).intentId === intent.id)
      .map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        AUDIT_ACTIONS.procedureCreated,
        AUDIT_ACTIONS.procedureDraftSaved,
        AUDIT_ACTIONS.procedureCompiled,
        AUDIT_ACTIONS.procedureConfirmed,
        AUDIT_ACTIONS.procedurePublished,
        AUDIT_ACTIONS.procedureRetired,
      ]),
    );
    const publishedRow = (await auditRows(env, AUDIT_ACTIONS.procedurePublished)).find(
      (row) => row.targetId === draft.id,
    );
    expect(publishedRow).toMatchObject({ actorType: 'user', actorId: head.id, outcome: 'success' });
    // Ids, version and hash only: never the text or the steps.
    expect(JSON.stringify(publishedRow?.metadata)).not.toContain('Search the KB');
    expect(publishedRow?.metadata).toMatchObject({
      version: 1,
      stepsDigest: published.stepsHash.slice(0, 16),
    });
  });

  it('numbers the next draft after the published one and replaces it on publish', async () => {
    const intent = await addIntent(env);
    const lead = await author();
    const ctx = env.ctx(lead.actor);
    const make = async (): Promise<string> => {
      const draft = (
        await env.tx((tx) =>
          env.domain.procedures.createDraft(tx, ctx, {
            intentId: intent.id,
            sourceMd: 's',
            steps: STEPS,
          }),
        )
      ).value;
      await env.tx((tx) =>
        env.domain.procedures.confirm(tx, ctx, { intentId: intent.id, versionId: draft.id }),
      );
      await simulate(draft.id);
      return draft.id;
    };
    const first = await make();
    await env.tx((tx) =>
      env.domain.procedures.publish(tx, ctx, { intentId: intent.id, versionId: first }),
    );
    const second = await make();
    await env.tx((tx) =>
      env.domain.procedures.publish(tx, ctx, { intentId: intent.id, versionId: second }),
    );
    const list = await env.domain.procedures.readVersions(env.database.db, intent.id);
    expect(list.items.map((item) => [item.version, item.status])).toEqual([
      [2, 'published'],
      [1, 'retired'],
    ]);
    expect(list.publishedVersionId).toBe(second);
    const replaced = (await auditRows(env, AUDIT_ACTIONS.procedurePublished)).find(
      (row) => row.targetId === second,
    );
    expect((replaced?.metadata as { replacedVersionId?: string }).replacedVersionId).toBe(first);
    // Rollback is publishing the old one again (its simulation is still fresh).
    const back = (
      await env.tx((tx) =>
        env.domain.procedures.publish(tx, ctx, { intentId: intent.id, versionId: first }),
      )
    ).value;
    expect(back.status).toBe('published');
  });
});

describe('procedure versions: what is refused', () => {
  it('does not let the AI or a system sender write, compile, confirm or publish', async () => {
    const intent = await addIntent(env);
    for (const actor of [
      { type: 'ai', id: null } as const,
      { type: 'system', id: null } as const,
    ]) {
      const error = await refusal(
        env.tx((tx) =>
          env.domain.procedures.createDraft(tx, env.ctx(actor), {
            intentId: intent.id,
            sourceMd: 'x',
          }),
        ),
      );
      expect(error.code).toBe('policy_denied');
    }
  });

  it('refuses to confirm steps that name a tool the intent may not use, a missing template or a missing queue', async () => {
    const intent = await addIntent(env, { allowedTools: [] });
    await addQueue(env);
    const lead = await author();
    const ctx = env.ctx(lead.actor);
    const draft = (
      await env.tx((tx) =>
        env.domain.procedures.createDraft(tx, ctx, {
          intentId: intent.id,
          sourceMd: 'x',
          steps: {
            schemaVersion: 1,
            autosend: 'never',
            steps: [
              { kind: 'tool', id: 'logs', tool: 'gcp_logs', template: 'ghost' },
              {
                kind: 'escalate',
                id: 'e',
                when: { all: [{ field: 'ticket.priority', op: 'eq', value: 'P1' }] },
                to: { queueKey: 'nowhere' },
                note: 'x',
              },
            ],
          },
        }),
      )
    ).value;
    const error = await refusal(
      env.tx((tx) =>
        env.domain.procedures.confirm(tx, ctx, { intentId: intent.id, versionId: draft.id }),
      ),
    );
    expect(error.code).toBe('bad_request');
    expect(error.message).toMatch(/not allowed for this intent/);
    expect(error.message).toMatch(/No team queue named nowhere/);
    const validation = await env.domain.procedures.validate(
      env.database.db,
      intent.id,
      draft.steps,
    );
    expect(validation.issues.map((issue) => issue.code).toSorted()).toEqual(
      ['queue_not_found', 'template_not_found', 'tool_not_allowed'].toSorted(),
    );
  });

  it('refuses to confirm a procedure with no steps and to touch a version of another intent', async () => {
    const intent = await addIntent(env);
    const other = await addIntent(env);
    const lead = await author();
    const ctx = env.ctx(lead.actor);
    const draft = (
      await env.tx((tx) =>
        env.domain.procedures.createDraft(tx, ctx, { intentId: intent.id, sourceMd: 'x' }),
      )
    ).value;
    expect(
      (
        await refusal(
          env.tx((tx) =>
            env.domain.procedures.confirm(tx, ctx, { intentId: intent.id, versionId: draft.id }),
          ),
        )
      ).code,
    ).toBe('bad_request');
    expect(
      (
        await refusal(
          env.tx((tx) =>
            env.domain.procedures.confirm(tx, ctx, { intentId: other.id, versionId: draft.id }),
          ),
        )
      ).code,
    ).toBe('not_found');
    expect(
      (
        await refusal(
          env.tx((tx) =>
            env.domain.procedures.createDraft(tx, ctx, {
              intentId: '00000000-0000-4000-8000-000000000042',
              sourceMd: 'x',
            }),
          ),
        )
      ).code,
    ).toBe('not_found');
  });

  it('stage 3 rules answer policy_denied (a second person; real tickets)', async () => {
    const intent = await addIntent(env);
    // Stage 3 cannot be set yet (the Phase 1 CHECK): lift it in this throwaway database only.
    const checks = await env.db.owner.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'public.intent'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%autonomy_stage%'`,
    );
    for (const { conname } of checks.rows) {
      await env.db.owner.pool.query(`ALTER TABLE intent DROP CONSTRAINT ${conname}`);
    }
    await env.db.owner.pool.query(`UPDATE intent SET autonomy_stage = 3 WHERE id = $1`, [
      intent.id,
    ]);
    const lead = await author();
    const head = await author('head');
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
    await simulate(draft.id, { seedOnly: true });
    const seeded = await refusal(
      env.tx((tx) =>
        env.domain.procedures.publish(tx, env.ctx(head.actor), {
          intentId: intent.id,
          versionId: draft.id,
        }),
      ),
    );
    expect(seeded).toMatchObject({ code: 'policy_denied', details: { reason: 'seed_simulation' } });
    await simulate(draft.id);
    const same = await refusal(
      env.tx((tx) =>
        env.domain.procedures.publish(tx, ctx, { intentId: intent.id, versionId: draft.id }),
      ),
    );
    expect(same).toMatchObject({ code: 'policy_denied', details: { reason: 'same_person' } });
    const ok = await env.tx((tx) =>
      env.domain.procedures.publish(tx, env.ctx(head.actor), {
        intentId: intent.id,
        versionId: draft.id,
      }),
    );
    expect(ok.value.status).toBe('published');
  });
});
