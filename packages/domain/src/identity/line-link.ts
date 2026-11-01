import { createHash, randomInt } from 'node:crypto';

import { schema } from '@watchtower/db';
import { AUDIT_ACTIONS, LINE_LINK_CODE_TTL_SECONDS } from '@watchtower/shared';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { contactSnapshot } from '../contacts.js';
import { conflict, isDomainError, notFound } from '../errors.js';
import type { ContactRow } from '../rows.js';
import { ticketEvent } from '../tickets/support.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';

/**
 * Who is behind a LINE user id (PRD R-2.11). LINE gives every sender an anonymous, per-provider
 * `userId`; the first message creates an `unverified` contact in the placeholder organization (see
 * `inbound/identity.ts`). Two ways in this file turn that into a known person:
 *
 *  - a link code: staff generate a short one-time code for a contact and hand it to the customer,
 *    who sends it in the LINE chat (`issueLineLinkCode`, `redeemLineLinkCode`);
 *  - LINE Login on the portal, where a signed-in client proves a LINE account is theirs
 *    (`linkLineUser` is called by the api once the login completed).
 *
 * Linking marks the contact verified: either the staff member vouched for the person they gave the
 * code to, or the customer is signed in to the portal and in control of the LINE account `[ASSUMED]`
 * (po confirms at T-115).
 */

// Crockford-like base 32 without 0 O 1 I L U: nothing to mistake when read aloud or retyped.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_PREFIX = 'WT';
const GROUP = 5;
const GROUP_TEXT = String(GROUP);

/**
 * `WT-ABCDE-FGHJK`: 10 characters from a 30-letter alphabet is about 49 bits. A code is valid for 15
 * minutes and works once, so guessing one is hopeless at chat speed `[ASSUMED]`; there is no
 * per-user attempt counter.
 */
export function generateLinkCode(): string {
  const pick = (): string => {
    let out = '';
    for (let index = 0; index < GROUP; index += 1)
      out += ALPHABET.charAt(randomInt(ALPHABET.length));
    return out;
  };
  return `${CODE_PREFIX}-${pick()}-${pick()}`;
}

const CODE_SHAPE = new RegExp(
  `^${CODE_PREFIX}[\\s-]*([${ALPHABET}]{${GROUP_TEXT}})[\\s-]*([${ALPHABET}]{${GROUP_TEXT}})$`,
);

/**
 * The canonical code in a chat message, or null when the message is anything else. Tolerant of the
 * way people retype: case, spaces or no dashes. The whole message must be the code (a sentence that
 * happens to contain one is a normal message).
 */
export function parseLinkCode(text: string): string | null {
  const match = CODE_SHAPE.exec(text.trim().toUpperCase());
  if (match === null) return null;
  return `${CODE_PREFIX}-${match[1] ?? ''}-${match[2] ?? ''}`;
}

export function hashLinkCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export interface IssueLinkCodeInput {
  readonly contactId: string;
  readonly ttlSeconds?: number;
}

export interface IssuedLinkCode {
  /** Shown once; only its hash is stored. */
  readonly code: string;
  readonly expiresAt: Date;
  readonly contactId: string;
}

/** Generates a code for a contact and retires that contact's earlier unused ones. Run as staff. */
export async function issueLineLinkCode(
  tx: DbTransaction,
  ctx: DomainContext,
  input: IssueLinkCodeInput,
): Promise<DomainResult<IssuedLinkCode>> {
  const fx = new Effects();
  const [contact] = await tx
    .select()
    .from(schema.contact)
    .where(eq(schema.contact.id, input.contactId))
    .for('update');
  if (contact === undefined) throw notFound('No such contact');
  const now = ctx.now();
  const expiresAt = new Date(
    now.getTime() + (input.ttlSeconds ?? LINE_LINK_CODE_TTL_SECONDS) * 1000,
  );
  // One live code per contact: handing out a second one cancels the first (it may have been mistyped to a stranger).
  await tx
    .update(schema.lineLinkCode)
    .set({ usedAt: now })
    .where(and(eq(schema.lineLinkCode.contactId, contact.id), isNull(schema.lineLinkCode.usedAt)));
  const code = generateLinkCode();
  await tx.insert(schema.lineLinkCode).values({
    contactId: contact.id,
    codeHash: hashLinkCode(code),
    createdBy: ctx.actor.id,
    createdAt: now,
    expiresAt,
  });
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.lineLinkCodeIssued,
    targetType: 'contact',
    targetId: contact.id,
    // The code is never in the log.
    metadata: { expiresAt: expiresAt.toISOString() },
  });
  return fx.result({ code, expiresAt, contactId: contact.id });
}

export type LinkVia = 'link_code' | 'line_login';

export interface LinkLineUserInput {
  readonly contactId: string;
  readonly lineUserId: string;
  readonly via: LinkVia;
}

export interface LinkedLineUser {
  readonly contact: ContactRow;
  /** Tickets of a placeholder contact for the same LINE user that now belong to `contact`. */
  readonly ticketsMoved: number;
  /** False when the contact was already linked to this LINE user. */
  readonly changed: boolean;
}

/**
 * Binds a LINE user id to a contact and marks the contact verified. If the LINE user already
 * messaged us they have an `unverified` contact of their own (placeholder organization): their
 * tickets follow them to the contact they are linked to, and the placeholder stops claiming the id
 * (one contact per LINE user, `contact_line_user_key`). Refuses to take a LINE user that belongs
 * to a verified contact, and a contact that is already linked to another LINE user.
 */
export async function linkLineUser(
  tx: DbTransaction,
  ctx: DomainContext,
  input: LinkLineUserInput,
): Promise<DomainResult<LinkedLineUser>> {
  const fx = new Effects();
  const now = ctx.now();
  const [target] = await tx
    .select()
    .from(schema.contact)
    .where(eq(schema.contact.id, input.contactId))
    .for('update');
  if (target === undefined) throw notFound('No such contact');
  if (target.lineUserId === input.lineUserId) {
    return fx.result({ contact: target, ticketsMoved: 0, changed: false });
  }
  if (target.lineUserId !== null) {
    throw conflict('This contact is already linked to another LINE account');
  }
  const [holder] = await tx
    .select()
    .from(schema.contact)
    .where(and(eq(schema.contact.lineUserId, input.lineUserId), ne(schema.contact.id, target.id)))
    .for('update');
  let moved: { id: string }[] = [];
  if (holder !== undefined) {
    if (holder.verifiedAt !== null) {
      throw conflict('This LINE account is already linked to another verified contact');
    }
    // Free the id first: the unique index allows one holder.
    await tx
      .update(schema.contact)
      .set({ lineUserId: null, mergedIntoContactId: target.id, updatedAt: now })
      .where(eq(schema.contact.id, holder.id));
    const tickets = await tx
      .update(schema.ticket)
      .set({ requesterContactId: target.id, orgId: target.orgId, updatedAt: now })
      .where(eq(schema.ticket.requesterContactId, holder.id))
      .returning();
    moved = tickets;
    for (const ticket of tickets)
      fx.emit(ticketEvent(ctx, 'ticket.updated', ticket, ['requester']));
  }
  const [updated] = await tx
    .update(schema.contact)
    .set({ lineUserId: input.lineUserId, verifiedAt: target.verifiedAt ?? now, updatedAt: now })
    .where(eq(schema.contact.id, target.id))
    .returning();
  if (updated === undefined) throw new Error('contact update returned no row');
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.lineLinked,
    targetType: 'contact',
    targetId: target.id,
    before: contactSnapshot(target),
    after: contactSnapshot(updated),
    // Counts and the method, not the LINE user id.
    metadata: {
      via: input.via,
      ticketsMoved: moved.length,
      mergedPlaceholder: holder !== undefined,
    },
  });
  return fx.result({ contact: updated, ticketsMoved: moved.length, changed: true });
}

export type RedeemOutcome =
  | { readonly status: 'linked'; readonly contactId: string; readonly ticketsMoved: number }
  /** Unknown, expired or already used: the same answer for all three, so a guess learns nothing. */
  | { readonly status: 'invalid' };

export interface RedeemInput {
  /** The canonical code from `parseLinkCode`. */
  readonly code: string;
  readonly lineUserId: string;
}

/**
 * The customer sent a code in LINE. The code is spent in the same statement that finds it, so two
 * deliveries of the same message (or two people racing) cannot both use it. A code that cannot be
 * used leaves nothing behind. Run as the system actor.
 */
export async function redeemLineLinkCode(
  tx: DbTransaction,
  ctx: DomainContext,
  input: RedeemInput,
): Promise<DomainResult<RedeemOutcome>> {
  const fx = new Effects();
  const now = ctx.now();
  // A savepoint: a refused link (the LINE user belongs to somebody else) must give the code back.
  try {
    return await tx.transaction(async (savepoint) => {
      const [spent] = await savepoint
        .update(schema.lineLinkCode)
        .set({ usedAt: now })
        .where(
          and(
            eq(schema.lineLinkCode.codeHash, hashLinkCode(input.code)),
            isNull(schema.lineLinkCode.usedAt),
            gt(schema.lineLinkCode.expiresAt, now),
          ),
        )
        .returning({ contactId: schema.lineLinkCode.contactId });
      if (spent === undefined) return fx.result({ status: 'invalid' } as const);
      const linked = await linkLineUser(savepoint, ctx, {
        contactId: spent.contactId,
        lineUserId: input.lineUserId,
        via: 'link_code',
      });
      fx.events.push(...linked.events);
      fx.audited = fx.audited || linked.audited;
      return fx.result({
        status: 'linked',
        contactId: spent.contactId,
        ticketsMoved: linked.value.ticketsMoved,
      } as const);
    });
  } catch (error) {
    // `conflict` from linkLineUser: the savepoint rolled back (the code is unused again). Report it as unusable.
    if (isDomainError(error)) {
      return fx.result({ status: 'invalid' } as const);
    }
    throw error;
  }
}
