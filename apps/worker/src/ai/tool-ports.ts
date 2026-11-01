import {
  stubFixturesSchema,
  type KbHit,
  type KbSearchPort,
  type OrgContext,
  type OrgContextPort,
  type SimilarTicket,
  type SimilarTicketsPort,
  type StubFixtures,
} from '@watchtower/ai';
import type { Database } from '@watchtower/db';
import { readActiveEmbeddingIndex, searchKb, type TicketKeys } from '@watchtower/domain';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AiRuntime } from './runtime.js';

/**
 * The real tools' data (T-108a), as ports for `@watchtower/ai`. Tickets and organizations are read
 * only through the `ai_v_*` views: the database role behind `db` decides what is reachable
 * (`watchtower_ai_ro` when `AI_READONLY_DATABASE_URL` is set, N2). The knowledge base search is the
 * one from T-107 (staff audience), on the application connection: it needs pgvector and the chunk
 * tables, which the views do not expose `[ASSUMED]`.
 */

export type ReadDb = Pick<Database['db'], 'execute' | 'transaction'>;

/** Longest a tool query may run. [ASSUMED] a trigram lookup over thousands of tickets takes tens of ms. */
export const TOOL_QUERY_TIMEOUT_MS = 3000;
/** Cheapest similarity worth showing (pg_trgm word similarity). [ASSUMED] tune with real tickets. */
export const SIMILAR_TICKET_MIN_SIMILARITY = 0.3;

interface SimilarRow extends Record<string, unknown> {
  id: string;
  number: string | number;
  subject: string;
  intent_key: string | null;
  status: string;
  same_org: boolean;
  similarity: number;
  snippet: string | null;
}

export function createSimilarTicketsPort(db: ReadDb, keys: TicketKeys): SimilarTicketsPort {
  return {
    async find(input) {
      return db.transaction(
        async (tx): Promise<SimilarTicket[]> => {
          await tx.execute(
            sql`SELECT set_config('statement_timeout', ${String(TOOL_QUERY_TIMEOUT_MS)}, true)`,
          );
          const result = await tx.execute<SimilarRow>(sql`
            WITH me AS (SELECT id, org_id FROM ai_v_ticket WHERE id = ${input.ticketId}::uuid)
            SELECT t.id, t.number, t.subject, t.intent_key, t.status,
                   (t.org_id = (SELECT org_id FROM me)) AS same_org,
                   word_similarity(${input.query}, t.subject) AS similarity,
                   (SELECT left(m.body_text, 400) FROM ai_v_ticket_message m
                     WHERE m.ticket_id = t.id AND m.direction = 'inbound'
                     ORDER BY m.created_at LIMIT 1) AS snippet
            FROM ai_v_ticket t
            WHERE t.id <> ${input.ticketId}::uuid
              AND word_similarity(${input.query}, t.subject) >= ${SIMILAR_TICKET_MIN_SIMILARITY}
            ORDER BY similarity DESC, t.created_at DESC
            LIMIT ${input.limit}
          `);
          return result.rows.map((row) => {
            const key = keys.format(Number(row.number));
            return {
              id: row.id,
              key,
              subject: row.subject.slice(0, 300),
              intentKey: row.intent_key,
              status: row.status,
              snippet: (row.snippet ?? '').slice(0, 600),
              similarity: Math.min(1, Math.max(0, row.similarity)),
              sameOrg: row.same_org,
              href: `/tickets/${key}`,
            };
          });
        },
        { accessMode: 'read only' },
      );
    },
  };
}

interface OrgRow extends Record<string, unknown> {
  id: string;
  name: string;
  tier: string;
  status: string;
  open_tickets: string | number;
  last_30_days: string | number;
}

export function createOrgContextPort(db: ReadDb): OrgContextPort {
  return {
    async get(input): Promise<OrgContext | null> {
      return db.transaction(
        async (tx) => {
          await tx.execute(
            sql`SELECT set_config('statement_timeout', ${String(TOOL_QUERY_TIMEOUT_MS)}, true)`,
          );
          const result = await tx.execute<OrgRow>(sql`
            SELECT o.id, o.name, o.tier, o.status,
                   (SELECT count(*) FROM ai_v_ticket x
                     WHERE x.org_id = o.id AND x.status NOT IN ('resolved', 'closed', 'merged')) AS open_tickets,
                   (SELECT count(*) FROM ai_v_ticket x
                     WHERE x.org_id = o.id AND x.created_at > now() - interval '30 days') AS last_30_days
            FROM ai_v_ticket me
            JOIN ai_v_org o ON o.id = me.org_id
            WHERE me.id = ${input.ticketId}::uuid
          `);
          const row = result.rows[0];
          if (row === undefined) return null;
          return {
            orgName: row.name.slice(0, 300),
            tier: row.tier,
            status: row.status,
            openTickets: Number(row.open_tickets),
            ticketsLast30Days: Number(row.last_30_days),
            href: `/orgs/${row.id}`,
          };
        },
        { accessMode: 'read only' },
      );
    },
  };
}

export interface KbPortDeps {
  readonly db: Database['db'];
  readonly ai: Pick<AiRuntime, 'embedder' | 'settings'>;
}

/** The query as a vector with the id of the active index, or undefined for a keyword-only search. */
async function embedQuery(
  deps: KbPortDeps,
  query: string,
): Promise<{ vector: readonly number[]; indexId: string } | undefined> {
  try {
    const index = await readActiveEmbeddingIndex(deps.db);
    if (index === undefined) return undefined;
    const wanted = (await deps.ai.settings.load()).embedding;
    if (
      index.provider !== wanted.provider ||
      index.model !== wanted.model ||
      index.dimensions !== wanted.dimensions
    ) {
      return undefined;
    }
    const outcome = await deps.ai.embedder.embed({
      texts: [query],
      scope: `kb-query:investigate`,
      action: 'kb_query',
    });
    const vector = outcome.status === 'ok' ? outcome.embeddings[0] : undefined;
    return vector === undefined ? undefined : { vector, indexId: index.id };
  } catch {
    // Search never fails because of the embedding: it falls back to keywords.
    return undefined;
  }
}

export function createKbSearchPort(deps: KbPortDeps): KbSearchPort {
  return {
    async search(input): Promise<KbHit[]> {
      const embedding = await embedQuery(deps, input.query);
      const outcome = await searchKb(deps.db, {
        query: input.query,
        audience: { kind: 'staff' },
        limit: input.limit,
        ...(embedding === undefined ? {} : { embedding }),
      });
      const best = Math.max(0, ...outcome.hits.map((hit) => hit.score));
      const hits = outcome.hits.map(
        (hit): KbHit => ({
          articleId: hit.articleId,
          slug: hit.slug,
          title: hit.title,
          section: hit.section,
          snippet: hit.snippet.slice(0, 1200),
          score: best > 0 ? hit.score / best : 0,
          kind: hit.kind,
          lang: hit.lang,
          // Only an article written for every customer may support a claim to an unverified contact.
          customerVisible: hit.visibility === 'customer',
          isRunbook:
            hit.kind === 'runbook' && input.intentKey !== null && hit.intentTags.includes(input.intentKey),
          href: `/kb/${hit.slug}`,
        }),
      );
      // The runbook of the ticket's intent first, then the rest in rank order.
      return hits.toSorted((a, b) => Number(b.isRunbook) - Number(a.isRunbook));
    },
  };
}

/**
 * Fixtures for the three stubs (GCP Logs, BigQuery, repo), from a JSON file of `examples/tools/`.
 * Absent file: no stub is registered, so a run cannot call one (the report then lists no gap for
 * them because the intent could not have named a tool that does not exist). A file that does not
 * parse stops the worker: wrong fixtures would be an invented fact (N5).
 */
export function loadStubFixtures(dir: string | undefined): StubFixtures | undefined {
  if (dir === undefined || dir === '') return undefined;
  let raw: string;
  try {
    raw = readFileSync(join(dir, 'fixtures.json'), 'utf8');
  } catch {
    return undefined;
  }
  return stubFixturesSchema.parse(JSON.parse(raw));
}
