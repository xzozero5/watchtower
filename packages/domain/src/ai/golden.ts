import { schema, type Database } from '@watchtower/db';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';

/**
 * Golden answers (T-302a, PRD 6.4): replies a lead or head marked as a good answer to an intent, kept
 * redacted. The drafter reads a few of the same intent as examples of tone and content. This file only
 * reads: marking and removing are API routes with their own audit.
 */

/** [ASSUMED] Three examples are enough to show a style; more spend the prompt on someone else's ticket. */
export const GOLDEN_EXAMPLES_MAX = 3;

export interface GoldenExample {
  readonly id: string;
  /** Redacted: placeholders such as `[EMAIL_1]` stand where a person's details were. */
  readonly text: string;
  readonly language: 'th' | 'en' | null;
}

/**
 * The golden answers of one intent for a new draft: those in the customer's language first, then the
 * newest. At most `GOLDEN_EXAMPLES_MAX`. Deleted ones are never returned.
 *
 * T-306a C-8: only the golden answers of the same organization as the ticket, plus those a lead marked
 * `shareable` ("no customer-specific data"). An organization's own replies never reach another's drafter by default.
 */
export async function goldenExamplesFor(
  db: Pick<Database['db'], 'select'>,
  intentId: string,
  language: 'th' | 'en',
  orgId: string | null,
  limit: number = GOLDEN_EXAMPLES_MAX,
): Promise<GoldenExample[]> {
  const rows = await db
    .select({
      id: schema.goldenAnswer.id,
      text: schema.goldenAnswer.bodyRedacted,
      language: schema.goldenAnswer.language,
    })
    .from(schema.goldenAnswer)
    .innerJoin(schema.ticket, eq(schema.ticket.id, schema.goldenAnswer.ticketId))
    .where(
      and(
        eq(schema.goldenAnswer.intentId, intentId),
        isNull(schema.goldenAnswer.deletedAt),
        orgId === null
          ? eq(schema.goldenAnswer.shareable, true)
          : or(eq(schema.ticket.orgId, orgId), eq(schema.goldenAnswer.shareable, true)),
      ),
    )
    .orderBy(
      sql`(${schema.goldenAnswer.language} IS NOT DISTINCT FROM ${language}) DESC`,
      desc(schema.goldenAnswer.createdAt),
    )
    .limit(Math.min(limit, GOLDEN_EXAMPLES_MAX));
  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    language: row.language === 'th' || row.language === 'en' ? row.language : null,
  }));
}
