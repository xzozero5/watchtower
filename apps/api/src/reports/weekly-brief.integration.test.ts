import {
  ceoViewSchema,
  weeklyBriefDraftSchema,
  weeklyBriefPublishedSchema,
  weeklyBriefPublishResultSchema,
  weeklyBriefSchema,
  type CeoView,
  type ClaimEvidence,
  type WeeklyBriefContent,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';

// T-305c on the real application module and Postgres: who may read, edit and publish the weekly brief, that an edit
// cannot add evidence the model's draft did not have, that a publish queues one email per recipient and is final.
const net = disableNetConnect();

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let figures: CeoView;
const owner = () => h.db.owner.pool;
const run = (text: string, values: unknown[] = []) => owner().query(text, values);

const ticketChip = { kind: 'ticket', label: 'OPS-12', href: '/?ticket=OPS-12' } as const;
const incidentChip = { kind: 'incident', label: 'INC-3', href: '/incidents?incident=abc' } as const;
const metricChip = { kind: 'data', label: 'SLA compliance', href: '/dashboard/ceo' } as const;

const claim = (
  text: string,
  ...evidence: ClaimEvidence[]
) => ({
  text,
  evidence,
  uncited: evidence.length === 0,
});

const DRAFT: WeeklyBriefContent = {
  summary: [claim('SLA compliance fell to 90%.', metricChip)],
  rootCauses: [
    {
      title: 'Sign-in loop',
      claims: [claim('Nine tickets share the sign-in intent.', ticketChip)],
      ask: 'Review the session cookie',
    },
  ],
  decisions: [claim('INC-3 is still open.', incidentChip)],
};

let slot = 0;
async function seedDraft(
  over: { source?: string; content?: WeeklyBriefContent } = {},
): Promise<string> {
  slot += 1;
  const content = over.content ?? DRAFT;
  const day = `2026-12-${String(slot).padStart(2, '0')}`;
  const { rows } = await run(
    `INSERT INTO weekly_brief (slot_date, period_from, period_to, source, figures, content, ai_content, prompt_version, mock)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $6::jsonb, 1, true) RETURNING id`,
    [
      day,
      '2026-12-01T00:00:00Z',
      '2026-12-07T03:00:00Z',
      over.source ?? 'ai',
      JSON.stringify(figures),
      JSON.stringify(content),
    ],
  );
  return (rows[0] as { id: string }).id;
}

beforeAll(async () => {
  h = await startHarness({
    env: { WEEKLY_BRIEF_RECIPIENTS: 'Board@Example.test, ceo@example.test, board@example.test' },
  });
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  const view = await head.client.request<CeoView>('GET', '/v1/reports/ceo?days=7', {});
  figures = ceoViewSchema.parse(view.body);
});
afterAll(async () => {
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});
beforeEach(async () => {
  await run('DELETE FROM weekly_brief');
  await run(`DELETE FROM outbox WHERE queue = 'email'`);
});

describe('access (RBAC)', () => {
  it('lets a lead and a head read the published brief, refuses an agent and a visitor', async () => {
    for (const who of [lead, head]) {
      expect((await who.client.request('GET', '/v1/reports/ceo/brief', {})).status).toBe(200);
    }
    expect((await agent.client.request('GET', '/v1/reports/ceo/brief', {})).status).toBe(403);
    expect((await h.client().request('GET', '/v1/reports/ceo/brief', { csrf: false })).status).toBe(
      401,
    );
  });

  it('lets only a head see the draft, edit it and publish it', async () => {
    const id = await seedDraft();
    for (const who of [lead, agent]) {
      expect((await who.client.request('GET', '/v1/reports/ceo/brief/draft', {})).status).toBe(403);
      expect(
        (
          await who.client.request('PUT', `/v1/reports/ceo/brief/${id}`, {
            body: { content: DRAFT },
          })
        ).status,
      ).toBe(403);
      expect(
        (await who.client.request('POST', `/v1/reports/ceo/brief/${id}/publish`, { body: {} }))
          .status,
      ).toBe(403);
    }
  });
});

describe('reading', () => {
  it('says there is no brief yet, and the default recipients of the instance (lower case, no repeats)', async () => {
    const published = await head.client.request('GET', '/v1/reports/ceo/brief', {});
    expect(weeklyBriefPublishedSchema.parse(published.body)).toEqual({ brief: null });
    const draft = await head.client.request('GET', '/v1/reports/ceo/brief/draft', {});
    expect(weeklyBriefDraftSchema.parse(draft.body)).toEqual({
      draft: null,
      defaultRecipients: ['board@example.test', 'ceo@example.test'],
    });
  });

  it('gives the head the draft with the model text, and a draft is not shown on the page', async () => {
    const id = await seedDraft();
    const draft = weeklyBriefDraftSchema.parse(
      (await head.client.request('GET', '/v1/reports/ceo/brief/draft', {})).body,
    );
    expect(draft.draft).toMatchObject({ id, status: 'draft', source: 'ai', mock: true });
    expect(draft.draft?.aiContent).toEqual(DRAFT);
    expect(draft.draft?.figures.kpis.volume).toEqual(figures.kpis.volume);
    const published = weeklyBriefPublishedSchema.parse(
      (await lead.client.request('GET', '/v1/reports/ceo/brief', {})).body,
    );
    expect(published.brief).toBeNull();
  });
});

describe('editing', () => {
  it('lets the head reword, drop and add a sentence of their own; the model text stays', async () => {
    const id = await seedDraft();
    const edited: WeeklyBriefContent = {
      summary: [
        claim('SLA compliance fell to 90%, below our 95% target.', metricChip),
        claim('Our own note: the cause was a holiday backlog.'),
      ],
      rootCauses: [],
      decisions: DRAFT.decisions,
    };
    const response = await head.client.request('PUT', `/v1/reports/ceo/brief/${id}`, {
      body: { content: edited },
    });
    expect(response.status).toBe(200);
    const brief = weeklyBriefSchema.parse(response.body);
    expect(brief.content).toEqual(edited);
    expect(brief.content.summary[1]).toMatchObject({ uncited: true, evidence: [] });
    expect(brief.aiContent).toEqual(DRAFT);
    expect(brief.editedAt).not.toBeNull();
    const audit = await run(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'ceo.brief.edit'`,
    );
    expect((audit.rows[0] as { n: number }).n).toBe(1);
  });

  it('refuses evidence the model draft did not have, and a claim whose flag disagrees with its evidence', async () => {
    const id = await seedDraft();
    const invented = {
      ...DRAFT,
      summary: [
        claim('Everything is fine.', { kind: 'ticket', label: 'OPS-99', href: '/?ticket=OPS-99' }),
      ],
    };
    const refused = await head.client.request<ApiErrorBody>('PUT', `/v1/reports/ceo/brief/${id}`, {
      body: { content: invented },
    });
    expect(refused.status).toBe(400);
    const lying = { ...DRAFT, summary: [{ text: 'x', evidence: [], uncited: false }] };
    expect(
      (
        await head.client.request('PUT', `/v1/reports/ceo/brief/${id}`, {
          body: { content: lying },
        })
      ).status,
    ).toBe(400);
    const stored = await run('SELECT content FROM weekly_brief WHERE id = $1', [id]);
    expect((stored.rows[0] as { content: unknown }).content).toEqual(DRAFT);
  });

  it('answers 404 for a brief that does not exist', async () => {
    const response = await head.client.request(
      'PUT',
      '/v1/reports/ceo/brief/00000000-0000-4000-8000-000000000000',
      { body: { content: DRAFT } },
    );
    expect(response.status).toBe(404);
  });
});

describe('publishing', () => {
  it('publishes, shows it on the page, and queues one email per recipient with nothing in the clear', async () => {
    const id = await seedDraft();
    await head.client.request('PUT', `/v1/reports/ceo/brief/${id}`, {
      body: { content: { ...DRAFT, summary: [claim('SLA compliance fell to 90%.', metricChip)] } },
    });
    const response = await head.client.request('POST', `/v1/reports/ceo/brief/${id}/publish`, {
      body: { recipients: ['A@Example.test', 'b@example.test', 'a@example.test'] },
    });
    expect(response.status).toBe(201);
    const result = weeklyBriefPublishResultSchema.parse(response.body);
    expect(result.queued).toBe(2);
    expect(result.brief).toMatchObject({
      id,
      status: 'published',
      recipients: ['a@example.test', 'b@example.test'],
      aiContent: null,
    });

    const page = weeklyBriefPublishedSchema.parse(
      (await lead.client.request('GET', '/v1/reports/ceo/brief', {})).body,
    );
    expect(page.brief?.id).toBe(id);
    expect(page.brief?.content.summary[0]?.evidence[0]).toMatchObject({ href: '/dashboard/ceo' });
    // The page of a lead never carries the model's own text.
    expect(page.brief?.aiContent).toBeNull();
    const draft = weeklyBriefDraftSchema.parse(
      (await head.client.request('GET', '/v1/reports/ceo/brief/draft', {})).body,
    );
    expect(draft.draft).toBeNull();

    const { rows } = await run(
      `SELECT job_id, payload FROM outbox WHERE queue = 'email' AND job_id LIKE $1 ORDER BY job_id`,
      [`weekly-brief-${id}-%`],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows as { payload: Record<string, unknown> }[]) {
      expect(row.payload).toMatchObject({ kind: 'weekly_brief', locale: 'en' });
      expect(['a@example.test', 'b@example.test']).toContain(row.payload.to);
      expect(typeof row.payload.secret).toBe('string');
      expect(JSON.stringify(row.payload)).not.toContain('/dashboard/ceo');
      expect(row.payload).not.toHaveProperty('pageUrl');
      expect(row.payload.summary).toEqual(['SLA compliance fell to 90%. [SLA compliance]']);
    }
    const audit = await run(
      `SELECT metadata FROM audit_log WHERE action = 'ceo.brief.publish' AND target_id = $1`,
      [id],
    );
    expect(audit.rows).toHaveLength(1);
    expect((audit.rows[0] as { metadata: unknown }).metadata).toMatchObject({ queued: 2 });
  });

  it('uses the default recipients of the instance when the body names none', async () => {
    const id = await seedDraft();
    const response = await head.client.request('POST', `/v1/reports/ceo/brief/${id}/publish`, {
      body: {},
    });
    expect(weeklyBriefPublishResultSchema.parse(response.body)).toMatchObject({
      queued: 2,
      brief: { recipients: ['board@example.test', 'ceo@example.test'] },
    });
  });

  it('publishes with no email when the head empties the list', async () => {
    const id = await seedDraft();
    const response = await head.client.request('POST', `/v1/reports/ceo/brief/${id}/publish`, {
      body: { recipients: [] },
    });
    expect(weeklyBriefPublishResultSchema.parse(response.body)).toMatchObject({ queued: 0 });
    const { rows } = await run(`SELECT 1 FROM outbox WHERE queue = 'email'`);
    expect(rows).toHaveLength(0);
  });

  it('rejects an address that is not one, and more than fifty', async () => {
    const id = await seedDraft();
    for (const recipients of [
      ['not-an-address'],
      Array.from({ length: 51 }, (_, n) => `p${String(n)}@example.test`),
    ]) {
      expect(
        (
          await head.client.request('POST', `/v1/reports/ceo/brief/${id}/publish`, {
            body: { recipients },
          })
        ).status,
      ).toBe(400);
    }
  });

  it('is final: a second publish and an edit answer 409, nothing more is queued, the database refuses a change', async () => {
    const id = await seedDraft();
    await head.client.request('POST', `/v1/reports/ceo/brief/${id}/publish`, {
      body: { recipients: ['a@example.test'] },
    });
    const again = await head.client.request('POST', `/v1/reports/ceo/brief/${id}/publish`, {
      body: { recipients: ['b@example.test'] },
    });
    expect(again.status).toBe(409);
    expect(
      (
        await head.client.request('PUT', `/v1/reports/ceo/brief/${id}`, {
          body: { content: DRAFT },
        })
      ).status,
    ).toBe(409);
    const { rows } = await run(`SELECT 1 FROM outbox WHERE queue = 'email'`);
    expect(rows).toHaveLength(1);
    await expect(
      run(`UPDATE weekly_brief SET content = '{}'::jsonb WHERE id = $1`, [id]),
    ).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('a data-only draft can be published after the head writes the words (a sentence of their own is uncited)', async () => {
    const id = await seedDraft({
      source: 'data_only',
      content: { summary: [], rootCauses: [], decisions: [] },
    });
    const edited: WeeklyBriefContent = {
      summary: [claim('Quiet week, nothing to report.')],
      rootCauses: [],
      decisions: [],
    };
    expect(
      (
        await head.client.request('PUT', `/v1/reports/ceo/brief/${id}`, {
          body: { content: edited },
        })
      ).status,
    ).toBe(200);
    const response = await head.client.request('POST', `/v1/reports/ceo/brief/${id}/publish`, {
      body: { recipients: ['a@example.test'] },
    });
    const result = weeklyBriefPublishResultSchema.parse(response.body);
    expect(result.brief.source).toBe('data_only');
    expect(result.brief.content.summary[0]).toMatchObject({ uncited: true });
    const { rows } = await run(`SELECT payload FROM outbox WHERE queue = 'email'`);
    expect((rows[0] as { payload: { summary: string[] } }).payload.summary).toEqual([
      'Quiet week, nothing to report. (no evidence)',
    ]);
  });
});
