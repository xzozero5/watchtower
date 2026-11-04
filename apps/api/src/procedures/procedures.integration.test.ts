import { DevMockLlmProvider, type LlmProvider, type LlmRequest } from '@watchtower/ai';
import type {
  CompileProcedureResult,
  Intent,
  ProcedureValidation,
  ProcedureVersion,
  ProcedureVersionList,
  ProcedureVersionResult,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_LLM } from '../ai/ai-runtime.js';
import { startHarness, type Harness } from '../testing/harness.js';
import { apiIntent, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';

// T-303b: the procedure of an intent over HTTP: RBAC, the compiler (AI drafts, a person confirms), the
// freeze, and the publish door that wants a passing simulation.

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let dev: Persona;
let client: Persona;
let counter = 0;

const calls: LlmRequest[] = [];
let answer: unknown = undefined;

const COMPILED = {
  steps: {
    schemaVersion: 1,
    autosend: 'never',
    steps: [
      { kind: 'tool', id: 'kb', tool: 'kb_search' },
      { kind: 'check', id: 'c', question: 'Did the KB answer it?', evidenceFrom: ['kb'] },
    ],
  },
  assumptions: ['"Look in the KB" was read as a KB search.'],
};

const spy: LlmProvider = (() => {
  const inner = new DevMockLlmProvider();
  return {
    kind: 'mock' as const,
    generate: (request: LlmRequest) => {
      calls.push(request);
      if (request.prompt.id === 'procedure_compiler' && answer !== undefined) {
        return Promise.resolve({
          text: typeof answer === 'string' ? answer : JSON.stringify(answer),
          finishReason: 'stop' as const,
          usage: { inputTokens: 50, outputTokens: 20 },
          model: request.model,
        });
      }
      return inner.generate(request);
    },
  };
})();

const owner = () => h.db.owner.pool;
const base = (intent: Intent) => `/v1/intents/${intent.id}/procedure/versions`;

beforeAll(async () => {
  h = await startHarness({ overrides: [{ token: API_LLM, value: spy }] });
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  dev = await signIn(h, 'dev');
  const org = await lead.client.post<{ id: string }>('/v1/orgs', { name: 'Acme Procedures' });
  client = await signIn(h, 'client', org.body.id);
});
afterAll(async () => {
  await h.close();
});

const newIntent = (over: Record<string, unknown> = {}): Promise<Intent> =>
  apiIntent(lead, {
    key: `proc_${String(++counter)}`,
    name: `Procedure ${String(counter)}`,
    ...over,
  });

async function draft(
  intent: Intent,
  body: Record<string, unknown> = { sourceMd: 'Look in the KB first.' },
): Promise<ProcedureVersion> {
  const response = await lead.client.post<ProcedureVersion>(base(intent), body);
  if (response.status !== 201) throw new Error(`draft: ${JSON.stringify(response.body)}`);
  return response.body;
}

/** A passing simulation, the way the runner of T-303d will leave one. */
async function simulate(versionId: string, passed = true): Promise<void> {
  await owner().query(
    `INSERT INTO procedure_simulation (procedure_version_id, passed, case_count) VALUES ($1, $2, 4)`,
    [versionId, passed],
  );
}

async function actionsFor(versionId: string): Promise<string[]> {
  const rows = await owner().query<{ action: string }>(
    `SELECT action FROM audit_log WHERE target_id = $1 ORDER BY created_at, id`,
    [versionId],
  );
  return rows.rows.map((row) => row.action);
}

describe('who may do what', () => {
  it('lets agent, lead, head and dev read; a client and a visitor not', async () => {
    const intent = await newIntent();
    await draft(intent);
    for (const who of [agent, lead, head, dev]) {
      const response = await who.client.get<ProcedureVersionList>(base(intent));
      expect(response.status, who.session.user.role).toBe(200);
      expect(response.body.items).toHaveLength(1);
    }
    expect((await client.client.get(base(intent))).status).toBe(403);
    expect((await h.client().get(base(intent))).status).toBe(401);
  });

  it('lets only lead and head write, compile and confirm', async () => {
    const intent = await newIntent();
    const version = await draft(intent);
    for (const who of [agent, dev, client]) {
      expect((await who.client.post(base(intent), { sourceMd: 'x' })).status).toBe(403);
      expect(
        (await who.client.patch(`${base(intent)}/${version.id}`, { sourceMd: 'x' })).status,
      ).toBe(403);
      expect((await who.client.post(`${base(intent)}/${version.id}/compile`)).status).toBe(403);
      expect((await who.client.post(`${base(intent)}/${version.id}/confirm`)).status).toBe(403);
      expect((await who.client.post(`${base(intent)}/${version.id}/publish`)).status).toBe(403);
      expect((await who.client.post(`${base(intent)}/${version.id}/retire`)).status).toBe(403);
    }
    expect(
      (await head.client.patch(`${base(intent)}/${version.id}`, { sourceMd: 'by head' })).status,
    ).toBe(200);
  });
});

describe('writing a draft', () => {
  it('keeps the text and the steps, numbers the versions, and refuses a step the schema does not have', async () => {
    const intent = await newIntent();
    const first = await draft(intent);
    expect(first).toMatchObject({
      version: 1,
      status: 'draft',
      sourceMd: 'Look in the KB first.',
      authoredBy: lead.userId,
    });
    expect(first.steps.steps).toEqual([]);
    const second = await draft(intent, {
      sourceMd: 'Again',
      steps: {
        schemaVersion: 1,
        steps: [{ kind: 'tool', id: 'kb', tool: 'kb_search', params: { limit: 5 } }],
      },
    });
    expect(second.version).toBe(2);
    expect(second.steps.autosend).toBe('never');

    for (const steps of [
      {
        schemaVersion: 1,
        steps: [{ kind: 'tool', id: 'a', tool: 'gcp_logs', query: 'severity>=ERROR' }],
      },
      { schemaVersion: 1, steps: [{ kind: 'tool', id: 'a', tool: 'send_email' }] },
      { schemaVersion: 2, steps: [] },
      { schemaVersion: 1, autosend: 'always', steps: [] },
    ]) {
      const response = await lead.client.post<ApiErrorBody>(base(intent), { sourceMd: 'x', steps });
      expect(response.status).toBe(400);
    }
    expect((await lead.client.post(base(intent), { sourceMd: 'x'.repeat(8193) })).status).toBe(400);
    expect((await lead.client.patch(`${base(intent)}/${first.id}`, {})).status).toBe(400);

    const list = await lead.client.get<ProcedureVersionList>(base(intent));
    expect(list.body.items.map((item) => item.version)).toEqual([2, 1]);
    expect(list.body.publishedVersionId).toBeNull();
  });

  it('answers 404 for an intent or a version that is not there, or belongs to another intent', async () => {
    const intent = await newIntent();
    const other = await newIntent();
    const version = await draft(intent);
    expect((await lead.client.get(`${base(other)}/${version.id}`)).status).toBe(404);
    expect(
      (await lead.client.get(`/v1/intents/00000000-0000-4000-8000-000000000042/procedure/versions`))
        .status,
    ).toBe(404);
    expect(
      (
        await lead.client.post(
          `/v1/intents/00000000-0000-4000-8000-000000000042/procedure/versions`,
          { sourceMd: 'x' },
        )
      ).status,
    ).toBe(404);
    expect((await lead.client.get(`${base(intent)}/not-a-uuid`)).status).toBe(400);
  });
});

describe('compile: the AI drafts, a person confirms', () => {
  it('stores the steps in the draft, shows what is wrong and what was guessed, and redacts the text first', async () => {
    const intent = await newIntent();
    const version = await draft(intent, {
      sourceMd: 'When jane@customer.example writes in, look in the KB and ask if it answered.',
    });
    answer = COMPILED;
    calls.length = 0;
    const response = await lead.client.post<CompileProcedureResult>(
      `${base(intent)}/${version.id}/compile`,
    );
    expect(response.status).toBe(200);
    expect(response.body.version).toMatchObject({ id: version.id, status: 'draft' });
    expect(response.body.version.steps.steps.map((step) => step.id)).toEqual(['kb', 'c']);
    expect(response.body.version.compiledByAiRunId).not.toBeNull();
    expect(response.body.validation).toEqual({ ok: true, issues: [] });
    expect(response.body.assumptions).toHaveLength(1);
    expect(response.body.promptVersion).toBe(1);

    const sent = calls.filter((call) => call.prompt.id === 'procedure_compiler');
    expect(sent).toHaveLength(1);
    const seen = (sent[0]?.system ?? '') + (sent[0]?.messages.map((m) => m.content).join('') ?? '');
    expect(seen).not.toContain('jane@customer.example');

    // ai_run has the call: agent, prompt, and the redaction count; never the text.
    const run = await owner().query<{
      agent: string;
      prompt_id: string;
      redaction: { total: number };
    }>(`SELECT agent, prompt_id, redaction FROM ai_run WHERE id = $1`, [
      response.body.version.compiledByAiRunId,
    ]);
    expect(run.rows[0]).toMatchObject({
      agent: 'procedure_compiler',
      prompt_id: 'procedure_compiler',
    });
    expect(run.rows[0]?.redaction.total).toBeGreaterThanOrEqual(1);
    expect(await actionsFor(version.id)).toContain('procedure.compiled');
  });

  it('keeps the draft a draft: the person confirms, and only then is it frozen', async () => {
    const intent = await newIntent();
    const version = await draft(intent);
    answer = COMPILED;
    await lead.client.post(`${base(intent)}/${version.id}/compile`);
    const confirmed = await lead.client.post<ProcedureVersionResult>(
      `${base(intent)}/${version.id}/confirm`,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.version).toMatchObject({ status: 'confirmed', confirmedBy: lead.userId });
    expect(confirmed.body.validation.ok).toBe(true);
    // Frozen: no edit, no second compile, no second confirm.
    expect(
      (await lead.client.patch(`${base(intent)}/${version.id}`, { sourceMd: 'late' })).status,
    ).toBe(409);
    expect((await lead.client.post(`${base(intent)}/${version.id}/compile`)).status).toBe(409);
    expect((await lead.client.post(`${base(intent)}/${version.id}/confirm`)).status).toBe(409);
  });

  it('refuses to confirm steps that name a tool the intent may not use, and says which', async () => {
    const intent = await newIntent();
    const version = await draft(intent, {
      sourceMd: 'Look at the logs.',
      steps: { schemaVersion: 1, steps: [{ kind: 'tool', id: 'logs', tool: 'gcp_logs' }] },
    });
    const validation = await lead.client.get<ProcedureValidation>(
      `${base(intent)}/${version.id}/validation`,
    );
    expect(validation.body.ok).toBe(false);
    expect(validation.body.issues[0]).toMatchObject({ code: 'tool_not_allowed', stepId: 'logs' });
    const confirm = await lead.client.post<ApiErrorBody>(`${base(intent)}/${version.id}/confirm`);
    expect(confirm.status).toBe(400);
    expect(confirm.body.message).toMatch(/not allowed for this intent/);
    // Allow the tool on the intent and it passes.
    await lead.client.patch(`/v1/intents/${intent.id}`, { allowedTools: ['gcp_logs'] });
    expect((await lead.client.post(`${base(intent)}/${version.id}/confirm`)).status).toBe(200);
  });

  it('answers 502 when the model breaks the schema, and writes nothing into the draft', async () => {
    const intent = await newIntent();
    const version = await draft(intent);
    for (const bad of [
      'sorry, no',
      {
        steps: {
          schemaVersion: 1,
          steps: [{ kind: 'tool', id: 'a', tool: 'gcp_logs', query: 'x' }],
        },
      },
    ]) {
      answer = bad;
      const response = await lead.client.post<ApiErrorBody>(
        `${base(intent)}/${version.id}/compile`,
      );
      expect(response.status).toBe(502);
      expect(response.body.code).toBe('ai_unavailable');
    }
    const after = await lead.client.get<ProcedureVersion>(`${base(intent)}/${version.id}`);
    expect(after.body.steps.steps).toEqual([]);
    expect(after.body.compiledByAiRunId).toBeNull();
  });

  it('answers 503 while the kill switch is on, makes no model call, and still lets the steps be written by hand', async () => {
    const intent = await newIntent();
    const version = await draft(intent);
    answer = COMPILED;
    await owner().query(`UPDATE ai_switch SET is_on = true WHERE key = 'ai_kill_switch'`);
    try {
      calls.length = 0;
      const response = await lead.client.post<ApiErrorBody>(
        `${base(intent)}/${version.id}/compile`,
      );
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('ai_unavailable');
      expect(response.body.message).toContain('kill_switch_on');
      expect(calls.filter((call) => call.prompt.id === 'procedure_compiler')).toHaveLength(0);
      const byHand = await lead.client.patch<ProcedureVersion>(`${base(intent)}/${version.id}`, {
        steps: COMPILED.steps,
      });
      expect(byHand.status).toBe(200);
      expect((await lead.client.post(`${base(intent)}/${version.id}/confirm`)).status).toBe(200);
    } finally {
      await owner().query(`UPDATE ai_switch SET is_on = false WHERE key = 'ai_kill_switch'`);
    }
  });

  it('refuses to compile an empty text', async () => {
    const intent = await newIntent();
    const version = await draft(intent, { sourceMd: '   ' });
    expect((await lead.client.post(`${base(intent)}/${version.id}/compile`)).status).toBe(400);
  });
});

describe('publish needs a passing simulation', () => {
  async function confirmed(intent: Intent): Promise<ProcedureVersion> {
    const version = await draft(intent, { sourceMd: 'KB then check.', steps: COMPILED.steps });
    const response = await lead.client.post<ProcedureVersionResult>(
      `${base(intent)}/${version.id}/confirm`,
    );
    expect(response.status).toBe(200);
    return response.body.version;
  }

  it('is refused (409) with no simulation or a failing one, and the intent keeps the default runbook', async () => {
    const intent = await newIntent();
    const version = await confirmed(intent);
    const none = await head.client.post<ApiErrorBody>(`${base(intent)}/${version.id}/publish`);
    expect(none.status).toBe(409);
    await simulate(version.id, false);
    expect((await head.client.post(`${base(intent)}/${version.id}/publish`)).status).toBe(409);
    const after = await head.client.get<Intent>(`/v1/intents/${intent.id}`);
    expect(after.body.procedureVersionId).toBeNull();
  });

  it('publishes after a passing simulation, points the intent at it, and retires it back to the default', async () => {
    const intent = await newIntent();
    const version = await confirmed(intent);
    await simulate(version.id);
    const published = await head.client.post<ProcedureVersion>(
      `${base(intent)}/${version.id}/publish`,
    );
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({
      status: 'published',
      publishedBy: head.userId,
      simulation: { passed: true, caseCount: 4 },
    });
    expect(
      (await head.client.get<Intent>(`/v1/intents/${intent.id}`)).body.procedureVersionId,
    ).toBe(version.id);
    const list = await agent.client.get<ProcedureVersionList>(base(intent));
    expect(list.body.publishedVersionId).toBe(version.id);

    expect((await head.client.post(`${base(intent)}/${version.id}/publish`)).status).toBe(409);
    const retired = await head.client.post<ProcedureVersion>(
      `${base(intent)}/${version.id}/retire`,
    );
    expect(retired.body.status).toBe('retired');
    expect(
      (await head.client.get<Intent>(`/v1/intents/${intent.id}`)).body.procedureVersionId,
    ).toBeNull();
    expect((await head.client.post(`${base(intent)}/${version.id}/retire`)).status).toBe(409);

    // Every step is on the record, with ids and the digest only.
    expect(await actionsFor(version.id)).toEqual(
      expect.arrayContaining(['procedure.confirmed', 'procedure.published', 'procedure.retired']),
    );
    const row = await owner().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE target_id = $1 AND action = 'procedure.published'`,
      [version.id],
    );
    expect(row.rows).toHaveLength(1);
    expect(JSON.stringify(row.rows[0]?.metadata)).not.toContain('KB then check');
    expect(row.rows[0]?.metadata).toMatchObject({ version: 1, versionId: version.id });
  });

  it('cannot be bypassed by editing the intent: the pointer is not a field of the intent', async () => {
    const intent = await newIntent();
    const version = await confirmed(intent);
    const response = await lead.client.patch(`/v1/intents/${intent.id}`, {
      procedureVersionId: version.id,
    });
    expect([200, 400]).toContain(response.status);
    expect(
      (await head.client.get<Intent>(`/v1/intents/${intent.id}`)).body.procedureVersionId,
    ).toBeNull();
  });
});
