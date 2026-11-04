import type { Database } from '@watchtower/db';
import { schema } from '@watchtower/db';
import {
  AUTOSEND_SAMPLING_DEFAULT,
  AUTOSEND_SAMPLING_KEY,
  autosendSamplingSchema,
  type AutosendSampling,
} from '@watchtower/shared';
import { eq, sql } from 'drizzle-orm';

import type { ReadExecutor } from '../types.js';

/**
 * Sampled grades of automatic replies that were sent (T-306e C-4c, ADR-025 section 7). The pre-send grade is made
 * before the send by the same kind of model that wrote the reply; a second look at what actually went out is what
 * can catch a violation the first one missed. The first `initialCount` replies after a promotion are all looked at
 * (100%), then a share (`percent`, 20%) `[ASSUMED]`. A violation in a sampled grade is a rollback rule of the
 * watch (`violation`), so the intent goes back to stage 2 at once.
 */

/** The sampling settings of the instance; the defaults when the row is missing or unreadable. */
export async function readAutosendSampling(db: ReadExecutor): Promise<AutosendSampling> {
  const [row] = await db
    .select({ value: schema.instanceSetting.value })
    .from(schema.instanceSetting)
    .where(eq(schema.instanceSetting.key, AUTOSEND_SAMPLING_KEY))
    .limit(1);
  const parsed = autosendSamplingSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : { ...AUTOSEND_SAMPLING_DEFAULT };
}

/** A sent automatic reply that is due a sampled grade. `text` is what the customer got (the message body). */
export interface SampleCandidate {
  readonly deliveryId: string;
  readonly ticketId: string;
  readonly aiDraftId: string;
  readonly text: string;
  /** 1 for the first automatic reply after the promotion. */
  readonly rank: number;
}

interface CandidateRow extends Record<string, unknown> {
  delivery_id: string;
  ticket_id: string;
  ai_draft_id: string;
  body_text: string;
  rank: string;
}

/**
 * The sent automatic replies of an intent, since its last promotion and not seed data, that the sampling picks and
 * that have no sampled grade yet. The pick is a function of the delivery id (a hash), so it is the same on every
 * run and the periodic watch never re-rolls: a reply that was not picked stays not picked.
 */
export async function findSampleCandidates(
  db: Pick<Database['db'], 'execute'>,
  intentId: string,
  sampling: AutosendSampling,
  limit = 20,
): Promise<SampleCandidate[]> {
  const result = await db.execute<CandidateRow>(sql`
    WITH promo AS (
      SELECT coalesce(max(changed_at), 'epoch'::timestamptz) AS at
        FROM intent_autonomy_history
       WHERE intent_id = ${intentId}::uuid AND change = 'promotion'
    ),
    cfg AS (
      SELECT ${sampling.initialCount}::int AS initial_count, ${sampling.initialPercent}::int AS initial_percent,
             ${sampling.percent}::int AS percent
    ),
    sent AS (
      SELECT od.id AS delivery_id, od.ticket_id, od.message_id, g.ai_draft_id,
             row_number() OVER (ORDER BY od.sent_at, od.id) AS rank
        FROM outbound_delivery od
        JOIN ticket t ON t.id = od.ticket_id AND t.intent_id = ${intentId}::uuid AND t.seed_batch_id IS NULL
        JOIN ai_grade g ON g.id = od.ai_grade_id
       WHERE od.origin = 'ai_auto' AND od.state = 'sent' AND od.message_id IS NOT NULL
         AND od.sent_at >= (SELECT at FROM promo)
    )
    SELECT s.delivery_id, s.ticket_id, s.ai_draft_id, m.body_text, s.rank
      FROM sent s
      JOIN message m ON m.id = s.message_id
      CROSS JOIN cfg
      CROSS JOIN LATERAL (
        SELECT CASE WHEN s.rank <= cfg.initial_count THEN cfg.initial_percent ELSE cfg.percent END AS pct
      ) AS pick
     WHERE NOT EXISTS (
             SELECT 1 FROM ai_grade sg WHERE sg.phase = 'sampled' AND sg.ai_draft_id = s.ai_draft_id)
       AND (
         pick.pct >= 100
         OR (
           pick.pct > 0
           AND (('x' || encode(substring(sha256(convert_to(s.delivery_id::text, 'UTF8')) from 1 for 4), 'hex'))::bit(32)::bigint % 100)
               < pick.pct
         )
       )
     ORDER BY s.rank
     LIMIT ${limit}::int
  `);
  return result.rows.map((row) => ({
    deliveryId: row.delivery_id,
    ticketId: row.ticket_id,
    aiDraftId: row.ai_draft_id,
    text: row.body_text,
    rank: Number(row.rank),
  }));
}
