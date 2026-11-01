import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_KEY_MAX_AGE_SECONDS,
  OUTBOUND_TICKET_EVENTS,
  QUEUE_NAMES,
} from '@watchtower/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPolicyGate } from '../autonomy/gate.js';
import { SAFE_AUTO_ACK_TEMPLATES } from '../autonomy/safe-templates.js';
import { DomainError } from '../errors.js';
import type { NormalisedInboundMessage } from '../inbound/types.js';
import type { MessageRow, TicketRow } from '../rows.js';
import {
  addIntent,
  addOrg,
  addPolicy,
  addStaff,
  auditRows,
  eventTypes,
  startDomainTest,
  type DomainTestEnv,
} from '../testing/support.js';
import type { Actor, DomainContext } from '../types.js';
import {
  claimDelivery,
  denyDelivery,
  markDispatched,
  recordFailure,
  recordSent,
  sweepDeliveries,
  vetDelivery,
} from './dispatch.js';
import { billingPeriod, lockQuota, moveQuota } from './quota.js';
import { findReplyToken, sealReplyToken, spendReplyToken } from './reply-token.js';
import { readUndoSendSeconds, setUndoSendSeconds } from './settings.js';
import { contentHash } from './state.js';
import { renderSystemTemplate } from './templates.js';
import { approveAiDraftSent, scheduleCustomerSend, scheduleTemplateAck } from './schedule.js';
import { cancelSend } from './cancel.js';

const T0 = new Date('2030-01-07T10:00:00.000Z');
const SYSTEM: Actor = { type: 'system', id: null };
const AI: Actor = { type: 'ai', id: 'ai-run-1' };

let env: DomainTestEnv;
let gmailId: string;
let lineId: string;

beforeAll(async () => {
  env = await startDomainTest();
  await addPolicy(
    env,
    { P3: { first_response_min: 60, resolution_min: 240, calendar: '24x7' } },
    'standard',
  );
  const accounts = await env.db.owner.db
    .insert(schema.channelAccount)
    .values([
      { type: 'gmail', name: 'Support mailbox' },
      { type: 'line', name: 'Support LINE OA' },
    ])
    .returning();
  gmailId = accounts.find((account) => account.type === 'gmail')?.id ?? '';
  lineId = accounts.find((account) => account.type === 'line')?.id ?? '';
});
afterAll(async () => {
  await env.close();
});

/** A context with the real policy gate on the application connection, and a fixed clock. */
function ctxAt(actor: Actor, now: Date = T0, gate = true): DomainContext {
  return env.ctx(actor, {
    now: () => now,
    ...(gate ? { policyGate: createPolicyGate({ db: env.database.db }) } : {}),
  });
}

const owner = () => env.db.owner.db;

async function ticketOn(channel: 'gmail' | 'line' | 'portal', intentId?: string) {
  const org = await addOrg(env);
  const { value } = await env.tx((tx) =>
    env.domain.tickets.create(tx, env.ctx(undefined, { now: () => T0 }), {
      orgId: org.id,
      subject: 'Cannot sign in',
      body: 'Password rejected',
      requester: { email: `${randomUUID()}@customer.example.test`, name: 'Requester' },
      ...(intentId === undefined ? {} : { intentId }),
    }),
  );
  if (channel !== 'portal') {
    await owner()
      .update(schema.ticket)
      .set({ channel, channelAccountId: channel === 'gmail' ? gmailId : lineId })
      .where(eq(schema.ticket.id, value.ticket.id));
  }
  return ticketRow(value.ticket.id);
}

async function reply(
  ticket: TicketRow,
  staff: { id: string; actor: Actor },
  body: string,
  aiDraftId?: string,
  now: Date = T0,
) {
  return env.tx((tx) =>
    env.domain.tickets.reply(tx, ctxAt(staff.actor, now), {
      ref: ticket.id,
      reply: { body, ...(aiDraftId === undefined ? {} : { aiDraftId }) },
      sender: { kind: 'staff', userId: staff.id },
    }),
  );
}

const refusal = async (work: Promise<unknown>): Promise<DomainError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

async function deliveryOf(id: string) {
  const [row] = await owner()
    .select()
    .from(schema.outboundDelivery)
    .where(eq(schema.outboundDelivery.id, id));
  if (row === undefined) throw new Error('no such delivery');
  return row;
}
async function messageOf(id: string): Promise<MessageRow> {
  const [row] = await owner().select().from(schema.message).where(eq(schema.message.id, id));
  if (row === undefined) throw new Error('no such message');
  return row;
}
async function draftOf(id: string) {
  const [row] = await owner().select().from(schema.aiDraft).where(eq(schema.aiDraft.id, id));
  if (row === undefined) throw new Error('no such draft');
  return row;
}
async function addDraft(ticketId: string, body: string) {
  const [row] = await owner()
    .insert(schema.aiDraft)
    .values({ ticketId, bodyText: body })
    .returning();
  if (row === undefined) throw new Error('draft insert returned no row');
  return row;
}
async function ticketRow(id: string): Promise<TicketRow> {
  const [row] = await owner().select().from(schema.ticket).where(eq(schema.ticket.id, id));
  if (row === undefined) throw new Error('no such ticket');
  return row;
}

const later = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

describe('scheduling a staff reply (ADR-010)', () => {
  it('holds a Gmail reply for the undo window and counts the first response only when it is sent', async () => {
    const ticket = await ticketOn('gmail');
    const staff = await addStaff(env);
    const result = await reply(ticket, staff, 'We are looking into it');
    const { message, delivery } = result.value;

    expect(message.deliveryStatus).toBe('scheduled');
    expect(delivery).toMatchObject({
      state: 'scheduled',
      origin: 'human',
      channel: 'gmail',
      holdSeconds: 5,
      attempts: 0,
      createdBy: staff.id,
      aiDraftId: null,
      templateKey: null,
    });
    expect(delivery?.nextAttemptAt).toEqual(later(5));
    expect(delivery?.contentHash).toBe(contentHash('We are looking into it'));
    // The first response of the SLA waits for the provider (ADR-010 section 3).
    expect((await ticketRow(ticket.id)).firstRespondedAt).toBeNull();

    // The outbox row is a nudge held back until the window ends.
    const [outbox] = await owner()
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.queue, QUEUE_NAMES.outbound)));
    expect(outbox).toBeDefined();
    const jobs = await owner()
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.jobId, `delivery-${delivery?.id ?? ''}-0`));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.nextAttemptAt).toEqual(later(5));
    expect(jobs[0]?.payload).toEqual({ deliveryId: delivery?.id });

    // The audit row names ids and codes, never the text.
    const audit = (await auditRows(env, AUDIT_ACTIONS.outboundScheduled)).filter(
      (row) => row.targetId === delivery?.id,
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain('looking into it');
  });

  it('still shows a portal reply at once and creates no delivery', async () => {
    const ticket = await ticketOn('portal');
    const staff = await addStaff(env);
    const result = await reply(ticket, staff, 'Visible now');
    expect(result.value.message.deliveryStatus).toBe('delivered');
    expect(result.value.delivery).toBeNull();
    expect((await ticketRow(ticket.id)).firstRespondedAt).toEqual(T0);
  });

  it('follows the instance setting, 0 to 30 seconds, and refuses anything else', async () => {
    const head = await addStaff(env, 'head');
    expect(await readUndoSendSeconds(env.database.db)).toBe(5);
    await env.tx((tx) => setUndoSendSeconds(tx, ctxAt(head.actor), 0));
    const ticket = await ticketOn('line');
    const staff = await addStaff(env);
    const instant = await reply(ticket, staff, 'No hold');
    expect(instant.value.delivery?.holdSeconds).toBe(0);
    expect(instant.value.delivery?.nextAttemptAt).toEqual(T0);

    expect(
      (await refusal(env.tx((tx) => setUndoSendSeconds(tx, ctxAt(head.actor), 31)))).code,
    ).toBe('bad_request');
    expect(
      (await refusal(env.tx((tx) => setUndoSendSeconds(tx, ctxAt(head.actor), -1)))).code,
    ).toBe('bad_request');
    expect(
      (await refusal(env.tx((tx) => setUndoSendSeconds(tx, ctxAt(head.actor), 1.5)))).code,
    ).toBe('bad_request');
    await env.tx((tx) => setUndoSendSeconds(tx, ctxAt(head.actor), 30));
    expect(await readUndoSendSeconds(env.database.db)).toBe(30);
    await env.tx((tx) => setUndoSendSeconds(tx, ctxAt(head.actor), 5));
    expect(await auditRows(env, AUDIT_ACTIONS.outboundSettingSet)).not.toHaveLength(0);

    // The table itself refuses a value outside 0-30.
    await expect(
      owner().execute(
        `UPDATE instance_setting SET value = '31'::jsonb WHERE key = 'outbound.undo_send_seconds'`,
      ),
    ).rejects.toThrow();
  });

  it('falls back to the default when the setting row is damaged, never to 0', async () => {
    await owner().execute(`DELETE FROM instance_setting WHERE key = 'outbound.undo_send_seconds'`);
    try {
      expect(await readUndoSendSeconds(env.database.db)).toBe(5);
    } finally {
      await owner().execute(
        `INSERT INTO instance_setting (key, value) VALUES ('outbound.undo_send_seconds', '5'::jsonb)`,
      );
    }
  });

  it('refuses a Gmail reply on a ticket that has no Gmail account to send through', async () => {
    const ticket = await ticketOn('portal');
    await owner()
      .update(schema.ticket)
      .set({ channel: 'gmail' })
      .where(eq(schema.ticket.id, ticket.id));
    const staff = await addStaff(env);
    const error = await refusal(reply(ticket, staff, 'nowhere to go'));
    expect(error.code).toBe('bad_request');
  });

  it('refuses a send when no policy gate is configured (fail closed)', async () => {
    const ticket = await ticketOn('gmail');
    const staff = await addStaff(env);
    const error = await refusal(
      env.tx((tx) =>
        env.domain.tickets.reply(tx, ctxAt(staff.actor, T0, false), {
          ref: ticket.id,
          reply: { body: 'x' },
          sender: { kind: 'staff', userId: staff.id },
        }),
      ),
    );
    expect(error).toMatchObject({ code: 'policy_denied', details: { reason: 'no_policy_gate' } });
  });
});

describe('undo send', () => {
  async function scheduled() {
    const ticket = await ticketOn('gmail');
    const staff = await addStaff(env);
    const { value } = await reply(ticket, staff, 'Undo me');
    if (value.delivery === null || value.delivery === undefined) throw new Error('no delivery');
    return { ticket, staff, delivery: value.delivery, message: value.message };
  }
  const cancel = (
    s: { ticket: TicketRow; delivery: { id: string } },
    actor: Actor,
    now: Date,
    canCancelAny = false,
  ) =>
    env.tx((tx) =>
      cancelSend(tx, ctxAt(actor, now), {
        ref: s.ticket.id,
        deliveryId: s.delivery.id,
        canCancelAny,
      }),
    );

  it('cancels inside the window: delivery and message cancelled, audited, timeline event, draft untouched', async () => {
    const s = await scheduled();
    const result = await cancel(s, s.staff.actor, later(3));
    expect(result.value.state).toBe('cancelled');
    expect(result.value.cancelledBy).toBe(s.staff.id);
    expect((await messageOf(s.message.id)).deliveryStatus).toBe('cancelled');
    expect(await eventTypes(env, s.ticket.id)).toContain(
      OUTBOUND_TICKET_EVENTS.messageSendCancelled,
    );
    expect(
      (await auditRows(env, AUDIT_ACTIONS.outboundCancelled)).filter(
        (row) => row.targetId === s.delivery.id,
      ),
    ).toHaveLength(1);
    // Asking again is fine and writes nothing more.
    const again = await cancel(s, s.staff.actor, later(4));
    expect(again.value.state).toBe('cancelled');
    expect(
      (await auditRows(env, AUDIT_ACTIONS.outboundCancelled)).filter(
        (row) => row.targetId === s.delivery.id,
      ),
    ).toHaveLength(1);
  });

  it('answers 409 (conflict) once the window has ended, and the message still goes out', async () => {
    const s = await scheduled();
    const error = await refusal(cancel(s, s.staff.actor, later(5)));
    expect(error.code).toBe('conflict');
    expect((await deliveryOf(s.delivery.id)).state).toBe('scheduled');
  });

  it('answers 409 once the delivery is being sent or is sent', async () => {
    const s = await scheduled();
    const claimed = await env.tx((tx) => claimDelivery(tx, ctxAt(SYSTEM, later(6)), s.delivery.id));
    expect(claimed?.state).toBe('sending');
    expect((await refusal(cancel(s, s.staff.actor, later(4)))).code).toBe('conflict');
  });

  it('lets only the sender, a lead or the head undo', async () => {
    const s = await scheduled();
    const other = await addStaff(env);
    expect((await refusal(cancel(s, other.actor, later(1)))).code).toBe('forbidden');
    const lead = await addStaff(env, 'lead');
    const result = await cancel(s, lead.actor, later(1), true);
    expect(result.value.cancelledBy).toBe(lead.id);
  });

  it('answers not found for a delivery of another ticket', async () => {
    const s = await scheduled();
    const other = await ticketOn('gmail');
    const error = await refusal(
      env.tx((tx) =>
        cancelSend(tx, ctxAt(s.staff.actor, later(1)), {
          ref: other.id,
          deliveryId: s.delivery.id,
          canCancelAny: true,
        }),
      ),
    );
    expect(error.code).toBe('not_found');
  });

  it('is not claimable after an undo', async () => {
    const s = await scheduled();
    await cancel(s, s.staff.actor, later(1));
    expect(
      await env.tx((tx) => claimDelivery(tx, ctxAt(SYSTEM, later(10)), s.delivery.id)),
    ).toBeNull();
  });
});

describe('claim: at most once', () => {
  it('gives one of many concurrent claimers the delivery, and none before the hold ends', async () => {
    const ticket = await ticketOn('line');
    const staff = await addStaff(env);
    const { value } = await reply(ticket, staff, 'Race me');
    const id = value.delivery?.id ?? '';

    expect(await env.tx((tx) => claimDelivery(tx, ctxAt(SYSTEM, later(4)), id))).toBeNull();

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        env.tx((tx) => claimDelivery(tx, ctxAt(SYSTEM, later(6)), id)),
      ),
    );
    const winners = results.filter((row) => row !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ state: 'sending', attempts: 1 });
    expect((await deliveryOf(id)).attempts).toBe(1);
  });
});

describe('the policy gate (N3)', () => {
  it('refuses ai_auto at schedule time whoever asks, and leaves no delivery', async () => {
    const ticket = await ticketOn('gmail');
    const staff = await addStaff(env);
    const { message } = await env.tx(async (tx) => {
      const [row] = await tx
        .insert(schema.message)
        .values({
          ticketId: ticket.id,
          channelAccountId: gmailId,
          direction: 'outbound',
          bodyText: 'The AI wrote this',
          visibility: 'public',
          deliveryStatus: 'scheduled',
        })
        .returning();
      return { message: row as MessageRow };
    });
    for (const actor of [AI, staff.actor]) {
      const error = await refusal(
        env.tx((tx) =>
          scheduleCustomerSend(tx, ctxAt(actor), { ticket, message, origin: 'ai_auto' }),
        ),
      );
      expect(error.code).toBe('policy_denied');
    }
    const rows = await owner()
      .select()
      .from(schema.outboundDelivery)
      .where(eq(schema.outboundDelivery.messageId, message.id));
    expect(rows).toHaveLength(0);
    // The gate wrote its denial through its own connection, so the row survives the rollback.
    const denials = await auditRows(env, AUDIT_ACTIONS.autonomyPolicyDenied);
    expect(denials.some((row) => (row.metadata as { origin?: string }).origin === 'ai_auto')).toBe(
      true,
    );
  });

  it('refuses an AI actor replying as if it were a person', async () => {
    const ticket = await ticketOn('gmail');
    const error = await refusal(
      env.tx((tx) =>
        env.domain.tickets.reply(tx, ctxAt(AI), {
          ref: ticket.id,
          reply: { body: 'machine text' },
          sender: { kind: 'staff', userId: randomUUID() },
        }),
      ),
    );
    expect(error.code).toBe('policy_denied');
  });

  it('the table has no ai_auto origin at all', async () => {
    const ticket = await ticketOn('gmail');
    const staff = await addStaff(env);
    const { value } = await reply(ticket, staff, 'real');
    await expect(
      owner().execute(
        `UPDATE outbound_delivery SET origin = 'ai_auto' WHERE id = '${value.delivery?.id ?? ''}'`,
      ),
    ).rejects.toThrow();
  });
});

describe('AI drafts: the approval is bound to the exact text (A-2)', () => {
  it('sends an approved draft: records the approver and the hash, and the draft moves with the send', async () => {
    const ticket = await ticketOn('gmail', (await addIntent(env)).id);
    const staff = await addStaff(env);
    const draft = await addDraft(ticket.id, 'Please try again in a private window.');
    expect(draft.contentHash).toBe(contentHash('Please try again in a private window.'));

    const { value } = await reply(ticket, staff, 'Please try again in a private window.', draft.id);
    expect(value.delivery).toMatchObject({
      origin: 'ai_approved',
      aiDraftId: draft.id,
      approvedBy: staff.id,
      contentHash: draft.contentHash,
    });
    expect(await draftOf(draft.id)).toMatchObject({ status: 'approved', approvedBy: staff.id });

    // Undo returns the draft to waiting, so a person can edit and send it again.
    await env.tx((tx) =>
      cancelSend(tx, ctxAt(staff.actor, later(1)), {
        ref: ticket.id,
        deliveryId: value.delivery?.id ?? '',
        canCancelAny: false,
      }),
    );
    expect(await draftOf(draft.id)).toMatchObject({
      status: 'draft',
      approvedBy: null,
      approvedAt: null,
    });
  });

  it('refuses a tampered body: one character off is a different text', async () => {
    const ticket = await ticketOn('gmail', (await addIntent(env)).id);
    const staff = await addStaff(env);
    const draft = await addDraft(ticket.id, 'Your refund was issued.');
    const error = await refusal(reply(ticket, staff, 'Your refund was issued!', draft.id));
    expect(error).toMatchObject({
      code: 'policy_denied',
      details: { reason: 'ai_draft_content_mismatch' },
    });
    // Nothing was saved: no message, no delivery, the draft is untouched.
    expect(await draftOf(draft.id)).toMatchObject({ status: 'draft', approvedBy: null });
    const sent = await owner()
      .select()
      .from(schema.message)
      .where(eq(schema.message.ticketId, ticket.id));
    expect(sent.filter((row) => row.direction === 'outbound')).toHaveLength(0);
  });

  it('refuses a draft of another ticket, a missing draft, and a draft already used', async () => {
    const intent = await addIntent(env);
    const ticket = await ticketOn('gmail', intent.id);
    const other = await ticketOn('gmail', intent.id);
    const staff = await addStaff(env);
    const foreign = await addDraft(other.id, 'Text');
    expect((await refusal(reply(ticket, staff, 'Text', foreign.id))).details?.reason).toBe(
      'ai_draft_not_found',
    );
    expect((await refusal(reply(ticket, staff, 'Text', randomUUID()))).details?.reason).toBe(
      'ai_draft_not_found',
    );

    const draft = await addDraft(ticket.id, 'Once only');
    await reply(ticket, staff, 'Once only', draft.id);
    expect((await refusal(reply(ticket, staff, 'Once only', draft.id))).details?.reason).toBe(
      'ai_draft_not_pending',
    );
  });

  it('refuses at stage 0, where the AI may not even draft for customers', async () => {
    const intent = await addIntent(env);
    await owner()
      .update(schema.intent)
      .set({ autonomyStage: 0 })
      .where(eq(schema.intent.id, intent.id));
    const ticket = await ticketOn('gmail', intent.id);
    const staff = await addStaff(env);
    const draft = await addDraft(ticket.id, 'Draft at stage zero');
    const error = await refusal(reply(ticket, staff, 'Draft at stage zero', draft.id));
    expect(error.details?.reason).toBe('stage_0_no_customer_draft');
    // The same text written by the person is theirs and goes through.
    const own = await reply(ticket, staff, 'Draft at stage zero');
    expect(own.value.delivery?.origin).toBe('human');
  });

  it('refuses a draft on a ticket with no intent: autonomy is per intent, so there is no stage to allow it', async () => {
    const ticket = await ticketOn('gmail');
    const staff = await addStaff(env);
    const draft = await addDraft(ticket.id, 'Unclassified');
    expect((await refusal(reply(ticket, staff, 'Unclassified', draft.id))).details?.reason).toBe(
      'intent_unknown',
    );
  });

  it('only a person can send a draft: a client cannot name one', async () => {
    const ticket = await ticketOn('gmail');
    const draft = await addDraft(ticket.id, 'x');
    const error = await refusal(
      env.tx((tx) =>
        env.domain.tickets.reply(tx, ctxAt({ type: 'user', id: randomUUID() }), {
          ref: ticket.id,
          reply: { body: 'x', aiDraftId: draft.id },
          sender: {
            kind: 'client',
            userId: randomUUID(),
            orgId: ticket.orgId,
            email: 'someone@example.test',
            name: 'Someone',
          },
        }),
      ),
    );
    expect(error.code).toBe('bad_request');
  });

  it('on the portal the draft is bound too, and marked sent', async () => {
    const ticket = await ticketOn('portal', (await addIntent(env)).id);
    const staff = await addStaff(env);
    const draft = await addDraft(ticket.id, 'Portal draft');
    expect((await refusal(reply(ticket, staff, 'Portal draft!', draft.id))).details?.reason).toBe(
      'ai_draft_content_mismatch',
    );
    const ok = await reply(ticket, staff, 'Portal draft', draft.id);
    expect(ok.value.message.deliveryStatus).toBe('delivered');
    expect(await draftOf(draft.id)).toMatchObject({ status: 'sent', approvedBy: staff.id });
    // approveAiDraftSent on its own refuses a draft that is no longer waiting.
    const message = ok.value.message;
    const error = await refusal(
      env.tx((tx) =>
        approveAiDraftSent(tx, ctxAt(staff.actor), { ticket, message, aiDraftId: draft.id }),
      ),
    );
    expect(error.details?.reason).toBe('ai_draft_not_pending');
  });
});

describe('the gate is asked again at claim time', () => {
  async function scheduledDraft(intentId: string) {
    const ticket = await ticketOn('gmail', intentId);
    const staff = await addStaff(env);
    const draft = await addDraft(ticket.id, `Draft ${randomUUID()}`);
    const { value } = await reply(ticket, staff, draft.bodyText, draft.id);
    const claimed = await env.tx((tx) =>
      claimDelivery(tx, ctxAt(SYSTEM, later(6)), value.delivery?.id ?? ''),
    );
    if (claimed === null) throw new Error('not claimed');
    return { ticket, staff, draft, delivery: claimed };
  }

  it('lets an unchanged send through', async () => {
    const intent = await addIntent(env);
    const s = await scheduledDraft(intent.id);
    const vetting = await vetDelivery(env.database.db, ctxAt(SYSTEM, later(6)), s.delivery);
    expect(vetting.ok).toBe(true);
  });

  it('cancels with policy_denied when the intent was dropped to stage 0 during the hold', async () => {
    const intent = await addIntent(env);
    const s = await scheduledDraft(intent.id);
    await owner()
      .update(schema.intent)
      .set({ autonomyStage: 0 })
      .where(eq(schema.intent.id, intent.id));
    const vetting = await vetDelivery(env.database.db, ctxAt(SYSTEM, later(6)), s.delivery);
    expect(vetting).toEqual({ ok: false, reason: 'stage_0_no_customer_draft' });

    const denied = await env.tx((tx) =>
      denyDelivery(tx, ctxAt(SYSTEM, later(6)), s.delivery, 'stage_0_no_customer_draft'),
    );
    expect(denied.value).toBe(true);
    expect(await deliveryOf(s.delivery.id)).toMatchObject({
      state: 'cancelled',
      errorCode: 'policy_denied',
    });
    expect((await messageOf(s.delivery.messageId)).deliveryStatus).toBe('failed');
    expect(await draftOf(s.draft.id)).toMatchObject({ status: 'draft', approvedBy: null });
    const audit = (await auditRows(env, AUDIT_ACTIONS.outboundPolicyDenied)).filter(
      (row) => row.targetId === s.delivery.id,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.outcome).toBe('denied');
    expect(JSON.stringify(audit[0])).not.toContain('Draft ');
  });

  it('refuses when the text changed after it was scheduled', async () => {
    const intent = await addIntent(env);
    const s = await scheduledDraft(intent.id);
    await owner().execute(
      `UPDATE message SET body_text = 'something else' WHERE id = '${s.delivery.messageId}'`,
    );
    const vetting = await vetDelivery(env.database.db, ctxAt(SYSTEM, later(6)), s.delivery);
    expect(vetting).toEqual({ ok: false, reason: 'content_changed' });
  });

  it('refuses when the draft approval no longer matches (a different approver, or a different text)', async () => {
    const intent = await addIntent(env);
    const s = await scheduledDraft(intent.id);
    // The guard trigger would stop this swap; switch it off to prove the dispatcher checks as well.
    await owner().execute(`ALTER TABLE ai_draft DISABLE TRIGGER ai_draft_guard`);
    try {
      await owner().execute(
        `UPDATE ai_draft SET approved_by = '${randomUUID()}' WHERE id = '${s.draft.id}'`,
      );
      expect(await vetDelivery(env.database.db, ctxAt(SYSTEM, later(6)), s.delivery)).toEqual({
        ok: false,
        reason: 'ai_draft_not_approved',
      });
      await owner().execute(
        `UPDATE ai_draft SET approved_by = '${s.staff.id}' WHERE id = '${s.draft.id}'`,
      );
    } finally {
      await owner().execute(`ALTER TABLE ai_draft ENABLE TRIGGER ai_draft_guard`);
    }
    await owner().execute(
      `UPDATE ai_draft SET status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = '${s.draft.id}'`,
    );
    expect(await vetDelivery(env.database.db, ctxAt(SYSTEM, later(6)), s.delivery)).toEqual({
      ok: false,
      reason: 'ai_draft_not_approved',
    });
  });

  it('refuses with no_policy_gate when the dispatcher has no gate', async () => {
    const intent = await addIntent(env);
    const s = await scheduledDraft(intent.id);
    const vetting = await vetDelivery(env.database.db, ctxAt(SYSTEM, later(6), false), s.delivery);
    expect(vetting).toEqual({ ok: false, reason: 'no_policy_gate' });
  });

  it('a human reply is not blocked by the AI switches (the person decides)', async () => {
    const ticket = await ticketOn('gmail');
    const staff = await addStaff(env);
    const { value } = await reply(ticket, staff, 'Human text');
    const claimed = await env.tx((tx) =>
      claimDelivery(tx, ctxAt(SYSTEM, later(6)), value.delivery?.id ?? ''),
    );
    if (claimed === null) throw new Error('not claimed');
    await owner().execute(`UPDATE ai_switch SET is_on = true WHERE key = 'ai_kill_switch'`);
    try {
      expect((await vetDelivery(env.database.db, ctxAt(SYSTEM, later(6)), claimed)).ok).toBe(true);
    } finally {
      await owner().execute(`UPDATE ai_switch SET is_on = false WHERE key = 'ai_kill_switch'`);
    }
  });
});

describe('automatic acknowledgments render on the server (A-3)', () => {
  it('renders the text from the key, with no hold, no first response and no human sender', async () => {
    const ticket = await ticketOn('gmail');
    const result = await env.tx((tx) =>
      scheduleTemplateAck(tx, ctxAt(SYSTEM), { ref: ticket.id, templateKey: 'auto_ack.received' }),
    );
    const { delivery, message } = result.value;
    expect(message.bodyText).toContain(`OPS-${String(ticket.number)}`);
    expect(message.bodyText).toContain('เราได้รับเรื่องของคุณแล้ว');
    expect(delivery).toMatchObject({
      origin: 'system_template',
      templateKey: 'auto_ack.received',
      holdSeconds: 0,
      createdBy: null,
      approvedBy: null,
    });
    expect(delivery.nextAttemptAt).toEqual(T0);
    expect(message.senderUserId).toBeNull();

    // It is claimable at once, vets clean, and sending it is not a first response.
    const claimed = await env.tx((tx) => claimDelivery(tx, ctxAt(SYSTEM), delivery.id));
    if (claimed === null) throw new Error('not claimed');
    expect((await vetDelivery(env.database.db, ctxAt(SYSTEM), claimed)).ok).toBe(true);
    await env.tx((tx) => markDispatched(tx, ctxAt(SYSTEM), claimed, 'gmail_new'));
    await env.tx((tx) =>
      recordSent(
        tx,
        ctxAt(SYSTEM),
        { ...claimed, route: 'gmail_new' },
        {
          route: 'gmail_new',
          providerMessageId: 'g-ack',
          rfc822MessageId: 'wt.ack@app.example.test',
          providerThreadId: 'thread-ack',
          threadKey: 'gmail:thread-ack',
          alreadyAccepted: false,
        },
      ),
    );
    expect((await ticketRow(ticket.id)).firstRespondedAt).toBeNull();
  });

  it('adds the target of the SLA only for the key that has one', async () => {
    const ticket = await ticketOn('gmail');
    await owner()
      .update(schema.ticket)
      .set({ firstResponseDueAt: new Date('2030-01-07T12:30:00.000Z') })
      .where(eq(schema.ticket.id, ticket.id));
    const withSla = await env.tx((tx) =>
      scheduleTemplateAck(tx, ctxAt(SYSTEM), {
        ref: ticket.id,
        templateKey: 'auto_ack.received_with_sla',
      }),
    );
    expect(withSla.value.message.bodyText).toContain('2030-01-07 19:30 (UTC+7)');
  });

  it('refuses a key that is not on the safe list, and a body that is not what the key renders', async () => {
    const ticket = await ticketOn('gmail');
    const error = await refusal(
      env.tx((tx) =>
        scheduleTemplateAck(tx, ctxAt(SYSTEM), {
          ref: ticket.id,
          templateKey: 'custom.sales_pitch',
        }),
      ),
    );
    expect(error.code).toBe('policy_denied');

    const [message] = await owner()
      .insert(schema.message)
      .values({
        ticketId: ticket.id,
        channelAccountId: gmailId,
        direction: 'outbound',
        bodyText: 'Click here to win a prize',
        visibility: 'public',
        deliveryStatus: 'scheduled',
      })
      .returning();
    const smuggled = await refusal(
      env.tx((tx) =>
        scheduleCustomerSend(tx, ctxAt(SYSTEM), {
          ticket,
          message: message as MessageRow,
          origin: 'system_template',
          templateKey: 'auto_ack.received',
        }),
      ),
    );
    expect(smuggled.details?.reason).toBe('template_body_mismatch');

    // A person cannot use the template origin (the gate wants the system as the actor).
    const staff = await addStaff(env);
    const impersonated = await refusal(
      env.tx((tx) =>
        scheduleTemplateAck(tx, ctxAt(staff.actor), {
          ref: ticket.id,
          templateKey: 'auto_ack.received',
        }),
      ),
    );
    expect(impersonated.code).toBe('policy_denied');
  });
});

describe('recording results', () => {
  async function claimed(channel: 'gmail' | 'line' = 'gmail') {
    const ticket = await ticketOn(channel);
    const staff = await addStaff(env);
    const { value } = await reply(ticket, staff, `Result ${randomUUID()}`);
    const delivery = await env.tx((tx) =>
      claimDelivery(tx, ctxAt(SYSTEM, later(6)), value.delivery?.id ?? ''),
    );
    if (delivery === null) throw new Error('not claimed');
    return { ticket, staff, delivery, message: value.message };
  }
  const sentArgsFor = (id: string) => ({
    route: 'gmail_thread' as const,
    providerMessageId: `gmail-${id}`,
    rfc822MessageId: `wt.${id}@app.example.test`,
    providerThreadId: `thread-${id}`,
    threadKey: `gmail:thread-${id}`,
    alreadyAccepted: false,
  });

  it('sent: delivered, provider identity on the message, first response at the real send time, audited without text', async () => {
    const s = await claimed();
    await env.tx((tx) => markDispatched(tx, ctxAt(SYSTEM, later(6)), s.delivery, 'gmail_thread'));
    const result = await env.tx((tx) =>
      recordSent(tx, ctxAt(SYSTEM, later(7)), s.delivery, sentArgsFor(s.delivery.id)),
    );
    expect(result.value).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual(['message.created', 'ticket.updated']);
    expect(await deliveryOf(s.delivery.id)).toMatchObject({
      state: 'sent',
      route: 'gmail_thread',
      providerMessageId: `gmail-${s.delivery.id}`,
      rfc822MessageId: `wt.${s.delivery.id}@app.example.test`,
      sentAt: later(7),
    });
    expect(await messageOf(s.message.id)).toMatchObject({
      deliveryStatus: 'delivered',
      externalId: `gmail-${s.delivery.id}`,
      threadKey: `gmail:thread-${s.delivery.id}`,
    });
    expect((await ticketRow(s.ticket.id)).firstRespondedAt).toEqual(later(7));
    const audit = (await auditRows(env, AUDIT_ACTIONS.outboundSent)).filter(
      (row) => row.targetId === s.delivery.id,
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain('Result ');
    // A second report for the same delivery changes nothing.
    expect(
      (
        await env.tx((tx) =>
          recordSent(tx, ctxAt(SYSTEM, later(8)), s.delivery, sentArgsFor(s.delivery.id)),
        )
      ).value,
    ).toBe(false);
  });

  it('retry: back to scheduled with a later time and a new trigger; failure: message failed, event, audit', async () => {
    const s = await claimed();
    await env.tx((tx) =>
      recordFailure(tx, ctxAt(SYSTEM, later(6)), s.delivery, { action: 'retry', delaySeconds: 4 }),
    );
    expect(await deliveryOf(s.delivery.id)).toMatchObject({
      state: 'scheduled',
      attempts: 1,
      dispatchedAt: null,
    });
    expect((await deliveryOf(s.delivery.id)).nextAttemptAt).toEqual(later(10));
    const trigger = await owner()
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.jobId, `delivery-${s.delivery.id}-1`));
    expect(trigger).toHaveLength(1);
    expect(trigger[0]?.nextAttemptAt).toEqual(later(10));

    const again = await env.tx((tx) => claimDelivery(tx, ctxAt(SYSTEM, later(11)), s.delivery.id));
    expect(again?.attempts).toBe(2);
    const failed = await env.tx((tx) =>
      recordFailure(tx, ctxAt(SYSTEM, later(11)), again as NonNullable<typeof again>, {
        action: 'fail',
        errorCode: 'channel_timeout',
        outcomeUnknown: true,
      }),
    );
    expect(failed.value).toBe(true);
    expect(await deliveryOf(s.delivery.id)).toMatchObject({
      state: 'failed',
      errorCode: 'channel_timeout',
      outcomeUnknown: true,
    });
    expect((await messageOf(s.message.id)).deliveryStatus).toBe('failed');
    expect(await eventTypes(env, s.ticket.id)).toContain(
      OUTBOUND_TICKET_EVENTS.messageDeliveryFailed,
    );
    expect(
      (await auditRows(env, AUDIT_ACTIONS.outboundFailed)).filter(
        (row) => row.targetId === s.delivery.id,
      ),
    ).toHaveLength(1);
    expect((await ticketRow(s.ticket.id)).firstRespondedAt).toBeNull();

    // A late "it did go out" heals an unknown outcome, and only that.
    const healed = await env.tx((tx) =>
      recordSent(
        tx,
        ctxAt(SYSTEM, later(20)),
        again as NonNullable<typeof again>,
        sentArgsFor(s.delivery.id),
      ),
    );
    expect(healed.value).toBe(true);
    expect((await messageOf(s.message.id)).deliveryStatus).toBe('delivered');
  });

  it('a certain failure is not healed by a stray success report', async () => {
    const s = await claimed();
    await env.tx((tx) =>
      recordFailure(tx, ctxAt(SYSTEM, later(6)), s.delivery, {
        action: 'fail',
        errorCode: 'channel_auth',
        outcomeUnknown: false,
      }),
    );
    expect(
      (
        await env.tx((tx) =>
          recordSent(tx, ctxAt(SYSTEM, later(7)), s.delivery, sentArgsFor(s.delivery.id)),
        )
      ).value,
    ).toBe(false);
    expect((await deliveryOf(s.delivery.id)).state).toBe('failed');
  });

  it('a failed message can be sent again; the old delivery stays as the record', async () => {
    const s = await claimed();
    await env.tx((tx) =>
      recordFailure(tx, ctxAt(SYSTEM, later(6)), s.delivery, {
        action: 'fail',
        errorCode: 'channel_auth',
        outcomeUnknown: false,
      }),
    );
    // The unique index only covers active deliveries.
    const retry = await env.tx((tx) =>
      tx
        .insert(schema.outboundDelivery)
        .values({
          ticketId: s.ticket.id,
          messageId: s.message.id,
          channelAccountId: gmailId,
          channel: 'gmail',
          origin: 'human',
          contentHash: s.delivery.contentHash,
          holdSeconds: 0,
          nextAttemptAt: later(7),
          createdBy: s.staff.id,
        })
        .returning(),
    );
    expect(retry).toHaveLength(1);
    await expect(
      env.tx((tx) =>
        tx.insert(schema.outboundDelivery).values({
          ticketId: s.ticket.id,
          messageId: s.message.id,
          channelAccountId: gmailId,
          channel: 'gmail',
          origin: 'human',
          contentHash: s.delivery.contentHash,
          holdSeconds: 0,
          nextAttemptAt: later(7),
          createdBy: s.staff.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('thread matching: a customer reply that quotes our Message-ID lands on the ticket (T-122c)', async () => {
    const mail: NormalisedInboundMessage = {
      channelAccountId: gmailId,
      providerMessageId: `g-${randomUUID()}`,
      rfc822MessageId: `${randomUUID()}@customer.example.test`,
      threadKey: `gmail:t-${randomUUID()}`,
      threadCandidates: [],
      from: {
        address: `${randomUUID().slice(0, 8)}@cust.example.test`,
        name: 'Customer',
        lineUserId: null,
      },
      subject: 'Cannot sign in',
      bodyText: 'It broke',
      bodyHtml: null,
      attachments: [],
      receivedAt: T0,
      rawObjectKey: null,
      automated: { disposition: 'human', subtype: 'none', signals: [] },
    };
    const opened = await env.tx((tx) =>
      env.domain.inbound.ingest(tx, ctxAt(SYSTEM), { message: mail }),
    );
    const ticketId = opened.value.ticketId ?? '';
    const staff = await addStaff(env);
    const { value } = await reply({ id: ticketId } as TicketRow, staff, 'Try again');
    const claimedRow = await env.tx((tx) =>
      claimDelivery(tx, ctxAt(SYSTEM, later(6)), value.delivery?.id ?? ''),
    );
    if (claimedRow === null) throw new Error('not claimed');
    await env.tx((tx) =>
      recordSent(tx, ctxAt(SYSTEM, later(7)), claimedRow, {
        ...sentArgsFor(claimedRow.id),
        rfc822MessageId: `wt.${claimedRow.id}@app.example.test`,
        providerThreadId: null,
        threadKey: null,
      }),
    );
    const followUp: NormalisedInboundMessage = {
      ...mail,
      providerMessageId: `g-${randomUUID()}`,
      rfc822MessageId: `${randomUUID()}@customer.example.test`,
      // A different Gmail thread id would not match; only the header can.
      threadKey: `gmail:t-${randomUUID()}`,
      threadCandidates: [{ kind: 'in_reply_to', value: `wt.${claimedRow.id}@app.example.test` }],
      bodyText: 'Still broken',
      receivedAt: later(60),
    };
    const joined = await env.tx((tx) =>
      env.domain.inbound.ingest(tx, ctxAt(SYSTEM, later(60)), { message: followUp }),
    );
    expect(joined.value).toMatchObject({
      disposition: 'appended',
      ticketId,
      matchedBy: 'in_reply_to',
    });
  });
});

describe('claim fencing (review O-1)', () => {
  const sentArgs = (id: string) => ({
    route: 'gmail_thread' as const,
    providerMessageId: `fence-${id}`,
    rfc822MessageId: `wt.${id}@app.example.test`,
    providerThreadId: null,
    threadKey: null,
    alreadyAccepted: false,
  });

  async function stalled() {
    const ticket = await ticketOn('gmail');
    const staff = await addStaff(env);
    const { value } = await reply(ticket, staff, `Fence ${randomUUID()}`);
    const id = value.delivery?.id ?? '';
    // Worker A claims, then stalls past its lease.
    const a = await env.tx((tx) => claimDelivery(tx, ctxAt(SYSTEM, later(6)), id));
    if (a === null) throw new Error('A did not claim');
    // The sweeper releases it; worker B claims.
    await env.tx((tx) => sweepDeliveries(tx, ctxAt(SYSTEM, later(6 + 130))));
    expect(await deliveryOf(id)).toMatchObject({ state: 'scheduled', claimToken: null });
    const b = await env.tx((tx) => claimDelivery(tx, ctxAt(SYSTEM, later(6 + 131)), id));
    if (b === null) throw new Error('B did not claim');
    expect(b.claimToken).not.toBeNull();
    expect(b.claimToken).not.toBe(a.claimToken);
    return { id, a, b };
  }

  it('a worker that was replaced cannot dispatch', async () => {
    const { id, a, b } = await stalled();
    expect(
      await env.tx((tx) => markDispatched(tx, ctxAt(SYSTEM, later(140)), a, 'gmail_thread')),
    ).toBe(false);
    expect((await deliveryOf(id)).dispatchedAt).toBeNull();
    expect(
      await env.tx((tx) => markDispatched(tx, ctxAt(SYSTEM, later(140)), b, 'gmail_thread')),
    ).toBe(true);
  });

  it('a worker that was replaced cannot record a result, a failure or a refusal', async () => {
    const { id, a, b } = await stalled();
    const at140 = ctxAt(SYSTEM, later(140));
    expect((await env.tx((tx) => recordSent(tx, at140, a, sentArgs(id)))).value).toBe(false);
    expect(
      (await env.tx((tx) => recordFailure(tx, at140, a, { action: 'retry', delaySeconds: 1 })))
        .value,
    ).toBe(false);
    expect(
      (
        await env.tx((tx) =>
          recordFailure(tx, at140, a, {
            action: 'fail',
            errorCode: 'channel_auth',
            outcomeUnknown: false,
          }),
        )
      ).value,
    ).toBe(false);
    expect((await env.tx((tx) => denyDelivery(tx, at140, a, 'x'))).value).toBe(false);
    // Nothing changed for B, which still owns the row and can finish.
    expect(await deliveryOf(id)).toMatchObject({ state: 'sending', claimToken: b.claimToken });
    expect(
      (await env.tx((tx) => recordSent(tx, ctxAt(SYSTEM, later(141)), b, sentArgs(id)))).value,
    ).toBe(true);
  });

  it('a row with no token in hand, or the wrong one, is never written', async () => {
    const { b } = await stalled();
    const forged = { ...b, claimToken: null };
    expect(await env.tx((tx) => markDispatched(tx, ctxAt(SYSTEM), forged, 'gmail_thread'))).toBe(
      false,
    );
    expect(
      (await env.tx((tx) => recordSent(tx, ctxAt(SYSTEM), forged, sentArgs(b.id)))).value,
    ).toBe(false);
    const wrong = { ...b, claimToken: randomUUID() };
    expect(await env.tx((tx) => markDispatched(tx, ctxAt(SYSTEM), wrong, 'gmail_thread'))).toBe(
      false,
    );
  });

  it('a late answer from the claim that made the call still heals an unknown outcome', async () => {
    const ticket = await ticketOn('gmail');
    const staff = await addStaff(env);
    const { value } = await reply(ticket, staff, `Heal ${randomUUID()}`);
    const a = await env.tx((tx) =>
      claimDelivery(tx, ctxAt(SYSTEM, later(6)), value.delivery?.id ?? ''),
    );
    if (a === null) throw new Error('not claimed');
    await env.tx((tx) => markDispatched(tx, ctxAt(SYSTEM, later(6)), a, 'gmail_thread'));
    await env.tx((tx) => sweepDeliveries(tx, ctxAt(SYSTEM, later(6 + 130))));
    expect((await deliveryOf(a.id)).state).toBe('failed');
    expect(
      (await env.tx((tx) => recordSent(tx, ctxAt(SYSTEM, later(200)), a, sentArgs(a.id)))).value,
    ).toBe(true);
  });
});

describe('a draft closes when a late success heals its send', () => {
  it('goes back to sent, with the same approver', async () => {
    const ticket = await ticketOn('gmail', (await addIntent(env)).id);
    const staff = await addStaff(env);
    const draft = await addDraft(ticket.id, `Heal draft ${randomUUID()}`);
    const { value } = await reply(ticket, staff, draft.bodyText, draft.id);
    const a = await env.tx((tx) =>
      claimDelivery(tx, ctxAt(SYSTEM, later(6)), value.delivery?.id ?? ''),
    );
    if (a === null) throw new Error('not claimed');
    await env.tx((tx) =>
      recordFailure(tx, ctxAt(SYSTEM, later(7)), a, {
        action: 'fail',
        errorCode: 'channel_timeout',
        outcomeUnknown: true,
      }),
    );
    expect(await draftOf(draft.id)).toMatchObject({ status: 'draft', approvedBy: null });
    await env.tx((tx) =>
      recordSent(tx, ctxAt(SYSTEM, later(8)), a, {
        route: 'gmail_new',
        providerMessageId: `late-${a.id}`,
        rfc822MessageId: null,
        providerThreadId: null,
        threadKey: null,
        alreadyAccepted: false,
      }),
    );
    expect(await draftOf(draft.id)).toMatchObject({ status: 'sent', approvedBy: staff.id });
  });
});

describe('automatic acknowledgments are re-rendered at claim time (review O-4)', () => {
  async function ack() {
    const ticket = await ticketOn('gmail');
    const result = await env.tx((tx) =>
      scheduleTemplateAck(tx, ctxAt(SYSTEM), { ref: ticket.id, templateKey: 'auto_ack.received' }),
    );
    const claimedRow = await env.tx((tx) =>
      claimDelivery(tx, ctxAt(SYSTEM), result.value.delivery.id),
    );
    if (claimedRow === null) throw new Error('not claimed');
    return { ticket, claimedRow, message: result.value.message };
  }

  it('stores the render inputs and accepts the text they render', async () => {
    const s = await ack();
    expect(s.claimedRow.renderInputs).toMatchObject({
      ticketKey: `OPS-${String(s.ticket.number)}`,
      portalUrl: null,
      firstResponseDueAt: s.ticket.firstResponseDueAt?.toISOString() ?? null,
    });
    expect((await vetDelivery(env.database.db, ctxAt(SYSTEM), s.claimedRow)).ok).toBe(true);
  });

  it('refuses text that is not the render, even when the hash was brought along', async () => {
    const s = await ack();
    // A message rewritten and a delivery whose hash was made to follow it (owner; the app cannot).
    await owner().execute(`ALTER TABLE outbound_delivery DISABLE TRIGGER outbound_delivery_guard`);
    try {
      await owner().execute(
        `UPDATE message SET body_text = 'Click here to win' WHERE id = '${s.message.id}'`,
      );
      await owner().execute(
        `UPDATE outbound_delivery SET content_hash = '${contentHash('Click here to win')}' WHERE id = '${s.claimedRow.id}'`,
      );
    } finally {
      await owner().execute(`ALTER TABLE outbound_delivery ENABLE TRIGGER outbound_delivery_guard`);
    }
    const row = await deliveryOf(s.claimedRow.id);
    expect(await vetDelivery(env.database.db, ctxAt(SYSTEM), row)).toEqual({
      ok: false,
      reason: 'template_body_mismatch',
    });
  });

  it("refuses inputs that are not the ticket's own", async () => {
    const s = await ack();
    await owner().execute(`ALTER TABLE outbound_delivery DISABLE TRIGGER outbound_delivery_guard`);
    try {
      await owner().execute(
        `UPDATE outbound_delivery SET render_inputs = jsonb_set(render_inputs, '{portalUrl}', '"https://evil.example/"') WHERE id = '${s.claimedRow.id}'`,
      );
    } finally {
      await owner().execute(`ALTER TABLE outbound_delivery ENABLE TRIGGER outbound_delivery_guard`);
    }
    const row = await deliveryOf(s.claimedRow.id);
    expect((await vetDelivery(env.database.db, ctxAt(SYSTEM), row)).ok).toBe(false);
  });

  it('keeps the database allow-list and the domain allow-list the same', async () => {
    const rows = await owner().select().from(schema.outboundTemplateAllowlist);
    expect(rows.map((row) => row.key).sort()).toEqual([...SAFE_AUTO_ACK_TEMPLATES].sort());
  });

  it('renders every key into text that the database body pattern accepts, and refuses free text (N-3)', async () => {
    const rows = await owner().select().from(schema.outboundTemplateAllowlist);
    const variants = [
      { ticketKey: 'OPS-1', portalUrl: null, firstResponseDueAt: null },
      { ticketKey: 'OPS-1', portalUrl: 'https://portal.example/portal', firstResponseDueAt: null },
      {
        ticketKey: 'XY9-123456',
        portalUrl: 'http://localhost:3000/portal?x=1',
        firstResponseDueAt: new Date('2026-11-02T02:30:00.000Z'),
      },
      {
        ticketKey: 'OPS-7',
        portalUrl: null,
        firstResponseDueAt: new Date('2026-11-02T02:30:00.000Z'),
      },
    ];
    for (const row of rows) {
      for (const vars of variants) {
        const text = renderSystemTemplate(row.key, vars);
        expect(text, row.key).not.toBeNull();
        const matches = async (body: string): Promise<boolean> => {
          const result = await owner().execute<{ ok: boolean }>(
            sql`SELECT ${body}::text ~ ${row.bodyPattern}::text AS ok`,
          );
          return result.rows[0]?.ok === true;
        };
        expect(await matches(String(text)), `${row.key}: ${String(text)}`).toBe(true);
        expect(await matches(`${String(text)}\n\nBuy now`), row.key).toBe(false);
      }
    }
  });
});

describe('the sweeper (ADR-010 section 7)', () => {
  async function sending(
    channel: 'gmail' | 'line',
    route: 'gmail_thread' | 'line_push' | 'line_reply' | null,
  ) {
    const ticket = await ticketOn(channel);
    const staff = await addStaff(env);
    const { value } = await reply(ticket, staff, `Stuck ${randomUUID()}`);
    const claimedRow = await env.tx((tx) =>
      claimDelivery(tx, ctxAt(SYSTEM, later(6)), value.delivery?.id ?? ''),
    );
    if (claimedRow === null) throw new Error('not claimed');
    if (route !== null)
      await env.tx((tx) => markDispatched(tx, ctxAt(SYSTEM, later(6)), claimedRow, route));
    return { ticket, claimedRow };
  }

  it('puts a delivery that never reached the provider back to scheduled', async () => {
    const s = await sending('gmail', null);
    const result = await env.tx((tx) => sweepDeliveries(tx, ctxAt(SYSTEM, later(6 + 121))));
    expect(result.released).toBeGreaterThanOrEqual(1);
    expect(await deliveryOf(s.claimedRow.id)).toMatchObject({
      state: 'scheduled',
      dispatchedAt: null,
    });
  });

  it('fails a Gmail send of unknown outcome and does not repeat it', async () => {
    const s = await sending('gmail', 'gmail_thread');
    const result = await env.tx((tx) => sweepDeliveries(tx, ctxAt(SYSTEM, later(6 + 121))));
    expect(result.unknownOutcome).toBeGreaterThanOrEqual(1);
    expect(await deliveryOf(s.claimedRow.id)).toMatchObject({
      state: 'failed',
      errorCode: 'lease_expired',
      outcomeUnknown: true,
    });
    expect((await messageOf(s.claimedRow.messageId)).deliveryStatus).toBe('failed');
  });

  it('retries a LINE push of unknown outcome (its retry key makes a repeat safe), not a reply', async () => {
    const push = await sending('line', 'line_push');
    const replyRoute = await sending('line', 'line_reply');
    await env.tx((tx) => sweepDeliveries(tx, ctxAt(SYSTEM, later(6 + 121))));
    expect((await deliveryOf(push.claimedRow.id)).state).toBe('scheduled');
    expect((await deliveryOf(replyRoute.claimedRow.id)).state).toBe('failed');
  });

  it('leaves a live claim alone, re-triggers a late scheduled delivery, and blanks stale reply tokens', async () => {
    const live = await sending('gmail', 'gmail_thread');
    const lateTicket = await ticketOn('gmail');
    const staff = await addStaff(env);
    const { value } = await reply(lateTicket, staff, 'Late one', undefined, later(1000));
    const lateId = value.delivery?.id ?? '';
    const tokenOwner = await ticketOn('line');
    const [inbound] = await owner()
      .insert(schema.inboundMessage)
      .values({
        channelAccountId: lineId,
        providerMessageId: `l-${randomUUID()}`,
        receivedAt: T0,
        disposition: 'appended',
        ticketId: tokenOwner.id,
      })
      .returning();
    await owner()
      .update(schema.inboundMessage)
      .set({ replyTokenSealed: sealReplyToken(env.ctx(), inbound?.id ?? '', 'tok-stale') })
      .where(eq(schema.inboundMessage.id, inbound?.id ?? ''));

    const now = new Date(later(1000).getTime() + 5_000 + 125_000);
    const result = await env.tx((tx) => sweepDeliveries(tx, ctxAt(SYSTEM, now)));
    expect(result.retriggered).toContain(lateId);
    const triggers = await owner()
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.queue, QUEUE_NAMES.outbound));
    expect(triggers.some((row) => row.jobId.startsWith(`delivery-${lateId}-sweep-`))).toBe(true);
    expect(result.staleReplyTokens).toBeGreaterThanOrEqual(1);
    // A claim whose lease is still running is not touched (this sweep runs "before" its lease ends).
    const early = await env.tx((tx) => sweepDeliveries(tx, ctxAt(SYSTEM, later(10))));
    expect(early.unknownOutcome).toBe(0);
    expect((await deliveryOf(live.claimedRow.id)).state).toBe('failed');
  });

  // -- T-122e N-2: a repeat is bounded --------------------------------------------------------

  const quotaUsed = async (period: string): Promise<number> =>
    (await env.tx((tx) => lockQuota(tx, lineId, period, 300))).used;

  /** One lost attempt of a LINE push: claim, reserve like the dispatcher does, dispatch, never answer. */
  async function lostPushAttempt(deliveryId: string, claimAt: Date) {
    const row = await env.tx((tx) => claimDelivery(tx, ctxAt(SYSTEM, claimAt), deliveryId));
    if (row === null) throw new Error('not claimed');
    const period = billingPeriod(claimAt);
    await env.tx(async (tx) => {
      await lockQuota(tx, lineId, period, 300);
      await moveQuota(tx, lineId, period, 1, claimAt);
      await markDispatched(tx, ctxAt(SYSTEM, claimAt), row, 'line_push');
    });
    return row;
  }

  it('gives a lost LINE push its quota reservation back when it goes round again (N-2)', async () => {
    const s = await sending('line', null);
    const id = s.claimedRow.id;
    // sending() claimed it at later(6); turn that first attempt into a lost push.
    const period = billingPeriod(later(6));
    const before = await quotaUsed(period);
    await env.tx(async (tx) => {
      await moveQuota(tx, lineId, period, 1, later(6));
      await markDispatched(tx, ctxAt(SYSTEM, later(6)), s.claimedRow, 'line_push');
    });
    expect(await quotaUsed(period)).toBe(before + 1);

    const result = await env.tx((tx) => sweepDeliveries(tx, ctxAt(SYSTEM, later(6 + 121))));
    expect(result.retriedPush).toBeGreaterThanOrEqual(1);
    expect(await deliveryOf(id)).toMatchObject({ state: 'scheduled', route: 'line_push' });
    // The next attempt reserves its own push; the lost one must not be counted twice.
    expect(await quotaUsed(period)).toBe(before);
  });

  it('fails a LINE push that was lost DELIVERY_MAX_ATTEMPTS times as outcome_unknown and keeps its reservation (N-2)', async () => {
    const ticket = await ticketOn('line');
    const staff = await addStaff(env);
    const { value } = await reply(ticket, staff, `Endless ${randomUUID()}`);
    const id = value.delivery?.id ?? '';
    const period = billingPeriod(later(6));
    const before = await quotaUsed(period);

    let at = 6;
    for (let attempt = 1; attempt < DELIVERY_MAX_ATTEMPTS; attempt += 1) {
      await lostPushAttempt(id, later(at));
      const result = await env.tx((tx) => sweepDeliveries(tx, ctxAt(SYSTEM, later(at + 121))));
      expect(result.retriedPush).toBeGreaterThanOrEqual(1);
      expect((await deliveryOf(id)).state).toBe('scheduled');
      expect(await quotaUsed(period)).toBe(before);
      at += 121;
    }
    // The fifth lost attempt is the last one: the limit is a limit on claims, not on cycles.
    await lostPushAttempt(id, later(at));
    expect((await deliveryOf(id)).attempts).toBe(DELIVERY_MAX_ATTEMPTS);
    const last = await env.tx((tx) => sweepDeliveries(tx, ctxAt(SYSTEM, later(at + 121))));
    expect(last.retriedPush).toBe(0);
    expect(last.retryLimited).toBeGreaterThanOrEqual(1);
    expect(await deliveryOf(id)).toMatchObject({
      state: 'failed',
      errorCode: 'retry_exhausted',
      outcomeUnknown: true,
    });
    expect((await messageOf((await deliveryOf(id)).messageId)).deliveryStatus).toBe('failed');
    // This push may have reached LINE, which counts it: the reservation stays.
    expect(await quotaUsed(period)).toBe(before + 1);
    // No trigger is left for a failed row to be claimed again.
    expect(await env.tx((tx) => claimDelivery(tx, ctxAt(SYSTEM, later(at + 1000)), id))).toBeNull();
  });

  it('stops repeating a LINE push once its retry key may have expired, whatever the attempt count (N-2)', async () => {
    const s = await sending('line', 'line_push');
    const created = s.claimedRow.createdAt;
    const tooEarly = new Date(
      created.getTime() + (DELIVERY_RETRY_KEY_MAX_AGE_SECONDS - 600) * 1000,
    );
    const pastTtl = new Date(created.getTime() + (DELIVERY_RETRY_KEY_MAX_AGE_SECONDS + 600) * 1000);
    // Inside the window it is still repeated.
    const inside = await env.tx((tx) => sweepDeliveries(tx, ctxAt(SYSTEM, tooEarly)));
    expect(inside.retriedPush).toBeGreaterThanOrEqual(1);
    expect((await deliveryOf(s.claimedRow.id)).state).toBe('scheduled');
    // A second lost attempt past the window ends it.
    const again = await env.tx((tx) => claimDelivery(tx, ctxAt(SYSTEM, tooEarly), s.claimedRow.id));
    if (again === null) throw new Error('not claimed');
    await env.tx((tx) => markDispatched(tx, ctxAt(SYSTEM, tooEarly), again, 'line_push'));
    const result = await env.tx((tx) => sweepDeliveries(tx, ctxAt(SYSTEM, pastTtl)));
    expect(result.retryLimited).toBeGreaterThanOrEqual(1);
    expect(await deliveryOf(s.claimedRow.id)).toMatchObject({
      state: 'failed',
      errorCode: 'retry_key_expired',
      outcomeUnknown: true,
    });
  });

  it('reads the retry-key bound from the domain configuration (N-2)', async () => {
    const s = await sending('line', 'line_push');
    const base = ctxAt(SYSTEM, later(6 + 121));
    const strict: DomainContext = {
      ...base,
      config: { ...base.config, retryKeyMaxAgeSeconds: 100 },
    };
    await env.tx((tx) => sweepDeliveries(tx, strict));
    expect(await deliveryOf(s.claimedRow.id)).toMatchObject({
      state: 'failed',
      errorCode: 'retry_key_expired',
    });
  });

  it('stops a claim that never reaches the provider after DELIVERY_MAX_ATTEMPTS too, as a certain non-delivery (N-2)', async () => {
    const ticket = await ticketOn('gmail');
    const staff = await addStaff(env);
    const { value } = await reply(ticket, staff, `Never dispatched ${randomUUID()}`);
    const id = value.delivery?.id ?? '';
    let at = 6;
    for (let attempt = 1; attempt <= DELIVERY_MAX_ATTEMPTS; attempt += 1) {
      const row = await env.tx((tx) => claimDelivery(tx, ctxAt(SYSTEM, later(at)), id));
      expect(row?.attempts).toBe(attempt);
      await env.tx((tx) => sweepDeliveries(tx, ctxAt(SYSTEM, later(at + 121))));
      at += 121;
    }
    expect(await deliveryOf(id)).toMatchObject({
      state: 'failed',
      errorCode: 'retry_exhausted',
      outcomeUnknown: false,
    });
  });
});

describe('LINE reply token and quota counters', () => {
  async function inboundWithToken(ticketId: string, token: string, receivedAt = T0) {
    const [row] = await owner()
      .insert(schema.inboundMessage)
      .values({
        channelAccountId: lineId,
        providerMessageId: `l-${randomUUID()}`,
        receivedAt,
        disposition: 'appended',
        ticketId,
      })
      .returning();
    const id = row?.id ?? '';
    await owner()
      .update(schema.inboundMessage)
      .set({ replyTokenSealed: sealReplyToken(env.ctx(), id, token) })
      .where(eq(schema.inboundMessage.id, id));
    return id;
  }

  it('is spent exactly once, even when two dispatchers race for it', async () => {
    const ticket = await ticketOn('line');
    const id = await inboundWithToken(ticket.id, 'reply-token-1');
    const found = await env.tx((tx) => findReplyToken(tx, ticket.id));
    expect(found?.inboundMessageId).toBe(id);
    const spent = await Promise.all(
      Array.from({ length: 6 }, () => env.tx((tx) => spendReplyToken(tx, env.ctx(), id))),
    );
    expect(spent.filter((value) => value !== null)).toEqual(['reply-token-1']);
    expect(await env.tx((tx) => findReplyToken(tx, ticket.id))).toBeNull();
    const [row] = await owner()
      .select()
      .from(schema.inboundMessage)
      .where(eq(schema.inboundMessage.id, id));
    expect(row?.replyTokenSealed).toBeNull();
  });

  it('is bound to its row: a token copied onto another row does not open', async () => {
    const ticket = await ticketOn('line');
    const a = await inboundWithToken(ticket.id, 'token-a');
    const b = await inboundWithToken(ticket.id, 'token-b');
    const [rowA] = await owner()
      .select()
      .from(schema.inboundMessage)
      .where(eq(schema.inboundMessage.id, a));
    await owner()
      .update(schema.inboundMessage)
      .set({ replyTokenSealed: rowA?.replyTokenSealed ?? null })
      .where(eq(schema.inboundMessage.id, b));
    expect(await env.tx((tx) => spendReplyToken(tx, env.ctx(), b))).toBeNull();
  });

  it('counts pushes per account and month and never goes below zero', async () => {
    const period = '2030-01';
    const first = await env.tx((tx) => lockQuota(tx, lineId, period, 300));
    expect(first).toEqual({ used: 0, limit: 300 });
    await env.tx((tx) => moveQuota(tx, lineId, period, 2, T0));
    await env.tx((tx) => moveQuota(tx, lineId, period, -5, T0));
    expect(await env.tx((tx) => lockQuota(tx, lineId, period, 999))).toEqual({
      used: 0,
      limit: 300,
    });
    await expect(
      owner().execute(`UPDATE channel_quota_usage SET used = -1 WHERE period = '${period}'`),
    ).rejects.toThrow();
  });
});

describe('least privilege on the new tables', () => {
  it('the application role cannot change who/what of a delivery, a draft body, or delete anything', async () => {
    const ticket = await ticketOn('gmail');
    const staff = await addStaff(env);
    const { value } = await reply(ticket, staff, 'Privileges');
    const id = value.delivery?.id ?? '';
    const draft = await addDraft(ticket.id, 'Body');
    const app = env.database.pool;
    const denied = async (sql: string): Promise<void> => {
      await expect(app.query(sql)).rejects.toMatchObject({ code: '42501' });
    };
    await denied(
      `UPDATE outbound_delivery SET content_hash = '${'0'.repeat(64)}' WHERE id = '${id}'`,
    );
    await denied(`UPDATE outbound_delivery SET origin = 'human' WHERE id = '${id}'`);
    await denied(`UPDATE outbound_delivery SET ai_draft_id = NULL WHERE id = '${id}'`);
    await denied(`DELETE FROM outbound_delivery WHERE id = '${id}'`);
    await denied(`UPDATE ai_draft SET body_text = 'changed' WHERE id = '${draft.id}'`);
    await denied(`UPDATE ai_draft SET content_hash = '${'1'.repeat(64)}' WHERE id = '${draft.id}'`);
    await denied(`DELETE FROM ai_draft WHERE id = '${draft.id}'`);
    await denied(`INSERT INTO instance_setting (key, value) VALUES ('x', '1'::jsonb)`);
    await denied(`DELETE FROM channel_quota_usage`);
    await denied(`UPDATE message SET body_text = 'rewritten' WHERE id = '${value.message.id}'`);
    // What it may do.
    await app.query(`UPDATE outbound_delivery SET attempts = attempts WHERE id = '${id}'`);
  });

  it('the hash of a draft is computed by the database whatever the insert says', async () => {
    const ticket = await ticketOn('gmail');
    const [row] = await env.database.db
      .insert(schema.aiDraft)
      .values({ ticketId: ticket.id, bodyText: 'Real text', contentHash: 'f'.repeat(64) })
      .returning();
    expect(row?.contentHash).toBe(contentHash('Real text'));
  });
});
