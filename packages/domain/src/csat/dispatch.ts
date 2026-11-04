import type { Database } from '@watchtower/db';
import { schema } from '@watchtower/db';
import { and, eq, sql } from 'drizzle-orm';

/**
 * The at-most-once ledger of a CSAT email that goes out through a Gmail mailbox (T-174, migration
 * 0084, ADR-010 section 6). The outbox that carries the job is at-least-once, and Gmail has no
 * idempotency key, so the worker takes the (survey, kind) pair here before the send:
 *
 *  - `claimCsatEmail` is true once. A repeat of the job, a second worker, or a retry after a send that
 *    may have left finds the row and gets false: nothing is sent twice.
 *  - `finishCsatEmail` records the provider id after the send.
 *  - `releaseCsatEmail` gives the claim back when the send CERTAINLY did not leave (no mailbox, no
 *    token, a refusal before the message was handed over), so the retry may claim it again.
 *  - A claim that is never finished stays `claimed`: an unknown outcome, never repeated. A missing
 *    survey is better than two (the same rule as the replies of ADR-010).
 */

export type CsatEmailKind = 'survey' | 'reminder';

const MAX_ATTEMPTS = 20;

export async function claimCsatEmail(
  db: Database['db'],
  input: { readonly surveyId: string; readonly kind: CsatEmailKind; readonly accountId: string },
): Promise<boolean> {
  const rows = await db
    .insert(schema.csatEmailDispatch)
    .values({
      surveyId: input.surveyId,
      kind: input.kind,
      channelAccountId: input.accountId,
    })
    .onConflictDoUpdate({
      target: [schema.csatEmailDispatch.surveyId, schema.csatEmailDispatch.kind],
      set: {
        state: 'claimed',
        attempts: sql`${schema.csatEmailDispatch.attempts} + 1`,
        channelAccountId: input.accountId,
        errorCode: null,
        claimedAt: sql`now()`,
        finishedAt: null,
      },
      // Only a released claim can be taken again, and only a bounded number of times.
      setWhere: and(
        eq(schema.csatEmailDispatch.state, 'released'),
        sql`${schema.csatEmailDispatch.attempts} < ${MAX_ATTEMPTS}`,
      ),
    })
    .returning({ surveyId: schema.csatEmailDispatch.surveyId });
  return rows.length > 0;
}

export async function finishCsatEmail(
  db: Database['db'],
  input: {
    readonly surveyId: string;
    readonly kind: CsatEmailKind;
    readonly providerMessageId: string;
  },
): Promise<void> {
  await db
    .update(schema.csatEmailDispatch)
    .set({ state: 'sent', providerMessageId: input.providerMessageId, finishedAt: sql`now()` })
    .where(
      and(
        eq(schema.csatEmailDispatch.surveyId, input.surveyId),
        eq(schema.csatEmailDispatch.kind, input.kind),
      ),
    );
}

export async function releaseCsatEmail(
  db: Database['db'],
  input: {
    readonly surveyId: string;
    readonly kind: CsatEmailKind;
    readonly errorCode: string;
  },
): Promise<void> {
  await db
    .update(schema.csatEmailDispatch)
    .set({ state: 'released', errorCode: input.errorCode, finishedAt: sql`now()` })
    .where(
      and(
        eq(schema.csatEmailDispatch.surveyId, input.surveyId),
        eq(schema.csatEmailDispatch.kind, input.kind),
        eq(schema.csatEmailDispatch.state, 'claimed'),
      ),
    );
}
