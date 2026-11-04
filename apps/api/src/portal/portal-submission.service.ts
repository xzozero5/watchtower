import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  PORTAL_CATEGORY_INTENT_HINT,
  PORTAL_URGENCY_PRIORITY,
  customerStatus,
  emailDomain,
  maskEmail,
  type PortalSubmit,
  type PortalSubmitted,
  type TicketPriority,
} from '@watchtower/shared';
import { and, eq } from 'drizzle-orm';

import { AuditScope } from '../audit/audit-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { EmailTagService } from '../audit/email-tag.service.js';
import { verificationFailed } from '../auth/http-errors.js';
import { CLIENT_ORG_RESOLVER, type ClientOrgResolver } from '../auth/magic-link.service.js';
import { DATABASE } from '../database/database.module.js';
import { ContactsService } from '../orgs/contacts.service.js';
import { UnitOfWorkService, type DbTransaction } from '../realtime/unit-of-work.js';
import { TICKET_KEYS, type TicketKeys } from '../tickets/ticket-keys.js';
import type { TicketRow } from '../tickets/ticket-reader.js';
import { TicketsService } from '../tickets/tickets.service.js';
import {
  PortalAttachmentsService,
  type StoredAttachments,
  type UploadedFile,
} from './portal-attachments.service.js';
import {
  HUMAN_VERIFICATION,
  type HumanVerificationProvider,
  type VerificationFailure,
} from './human-verification.js';
import { PortalLimits } from './portal-limits.js';
import { PortalNotifier, oneLine } from './portal-notifier.js';

/**
 * Submissions whose address belongs to no organization yet are filed under this one, so they have
 * somewhere to wait for triage. A fixed id lets every instance and every request find it without a
 * lookup by name. Staff see the organization the customer wrote in `customFields.portal.organization`.
 */
export const UNMATCHED_ORG_ID = '00000000-0000-4000-8000-00000000a001';
const UNMATCHED_ORG_NAME = 'Unmatched portal submissions';

/**
 * The most urgent priority an unverified email address can obtain by choosing "everything is down"
 * `[ASSUMED]`. Portal submitters are never verified (C-4), so this applies to every portal ticket,
 * whether or not the address belongs to an organization.
 */
export const UNVERIFIED_PRIORITY_CAP: TicketPriority = 'P2';
const PRIORITY_ORDER: readonly TicketPriority[] = ['P1', 'P2', 'P3', 'P4'];

export interface SubmitContext {
  /** The client address as Express sees it (trusted proxies applied). */
  readonly ip: string | null;
}

function lowerPriority(wanted: TicketPriority, cap: TicketPriority): TicketPriority {
  return PRIORITY_ORDER.indexOf(wanted) < PRIORITY_ORDER.indexOf(cap) ? cap : wanted;
}

/** First line of the description, shortened: the portal form has no subject unless the customer gives one. */
export function deriveSubject(description: string): string {
  const line = oneLine(description.split('\n').find((part) => part.trim() !== '') ?? '', 120);
  return line === '' ? 'Support request' : line;
}

function composeBody(input: PortalSubmit): string {
  const ids = input.affectedRequestIds ?? [];
  if (ids.length === 0) return input.description;
  return `${input.description}\n\nAffected request IDs:\n${ids.map((id) => `- ${id}`).join('\n')}`;
}

/**
 * The public submit flow (R-9.1, R-9.2): address limit, stateless proof check, email and
 * organization limits, single-use claim of the proof (the order is explained in `submit`), then one transaction that
 * finds or creates the contact, files the ticket on the `portal` channel with its SLA, writes the
 * audit rows and the confirmation email (outbox). The tracking link is only in that email: the
 * response never carries it, so someone who types another person's address learns nothing.
 *
 * Attachments (R-9.1, T-140): the files are checked by their bytes right after the proof (a refusal
 * does not burn the proof), stored once the proof is claimed, and referenced from the first message
 * like mail attachments are. If the ticket is not saved (error, or the proof was already used) the
 * stored objects are deleted again.
 */
@Injectable()
export class PortalSubmissionService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(HUMAN_VERIFICATION) private readonly verification: HumanVerificationProvider,
    @Inject(PortalLimits) private readonly limits: PortalLimits,
    @Inject(CLIENT_ORG_RESOLVER) private readonly domains: ClientOrgResolver,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(PortalNotifier) private readonly notifier: PortalNotifier,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
    @Inject(EmailTagService) private readonly tags: EmailTagService,
    @Inject(PortalAttachmentsService) private readonly attachments: PortalAttachmentsService,
  ) {}

  async submit(
    input: PortalSubmit,
    context: SubmitContext,
    files: readonly UploadedFile[] = [],
  ): Promise<PortalSubmitted> {
    // Order matters (C-3, ADR-007): what costs the caller work comes before what spends a bucket
    // that belongs to someone else.
    //   1. the client address's own limit: whoever floods from one address pays for it, whatever
    //      they send;
    //   2. the stateless proof check (signature, expiry, fill time, honeypot, proof-of-work): free
    //      for us, not free for the caller, and touches no storage;
    //   3. the per-email and per-organization limits: only a request that did the work can spend a
    //      victim's bucket, so a script cannot exhaust the limit of an address it does not own;
    //   4. the single-use claim of the challenge: last, so a request the limits turned away does
    //      not burn a proof the person already paid for, and may be retried later.
    await this.limits.enforce('submit-ip', context.ip ?? 'unknown');

    const checked = await this.verification.check({
      proof: input.verification,
      honeypot: input.website,
    });
    if (!checked.ok) this.refuse(input.email, checked.reason);
    // Bytes are looked at only for a caller who did the proof-of-work, and before the single-use
    // claim, so a refused file leaves the proof usable.
    const prepared = this.attachments.prepare(files);

    await this.limits.enforce('submit-email', input.email);
    const placement = await this.place(input.email);
    await this.limits.enforce('submit-org', placement.limitSubject);

    const verified = await this.verification.claim(checked);
    if (!verified.ok) this.refuse(input.email, verified.reason);

    const reservation = await this.attachments.reserve(prepared, {
      ip: context.ip,
      email: input.email,
      org: placement.limitSubject,
    });
    let stored: StoredAttachments | undefined;
    let created: { ticket: TicketRow; ticketKey: string; duplicate: boolean };
    try {
      stored = await this.attachments.put(prepared);
      created = await this.createTicket(input, placement, verified.challengeId, stored);
    } catch (error) {
      if (stored !== undefined) await this.attachments.discard(stored.keys);
      await reservation.refund();
      throw error;
    }
    // The same submission again (the proof is its idempotency key): the first one's files are the ones kept.
    if (created.duplicate) {
      await this.attachments.discard(stored.keys);
      await reservation.refund();
    }

    return {
      ticketKey: created.ticketKey,
      maskedEmail: maskEmail(input.email),
      status: customerStatus('new'),
      expectedFirstResponseAt: created.ticket.firstResponseDueAt?.toISOString() ?? null,
    };
  }

  private async createTicket(
    input: PortalSubmit,
    placement: { orgId: string | null; limitSubject: string },
    challengeId: string,
    stored: StoredAttachments,
  ): Promise<{ ticket: TicketRow; ticketKey: string; duplicate: boolean }> {
    return this.uow.run(async (uow) => {
      const { tx } = uow;
      const orgId = placement.orgId ?? (await this.ensureUnmatchedOrg(tx));
      const hint = await this.activeIntentKey(tx, PORTAL_CATEGORY_INTENT_HINT[input.category]);
      // The address is only typed, never proven (no double opt-in, ADR-007), so what the
      // submitter says about urgency is a request, not a fact: it is capped at P2 for everyone.
      // Staff raise it after reading the ticket. `requesterVerified` and `urgencyCapped` tell them
      // (and a later staff UI) that this happened.
      const wanted = PORTAL_URGENCY_PRIORITY[input.urgency ?? 'question'];
      const priority =
        input.urgency === undefined ? undefined : lowerPriority(wanted, UNVERIFIED_PRIORITY_CAP);

      const result = await this.tickets.create(uow, {
        actor: { type: 'anonymous', id: null },
        orgId,
        subject: input.subject ?? deriveSubject(input.description),
        body: composeBody(input),
        channel: 'portal',
        // The challenge id is single-use, so it doubles as the idempotency key of the submission.
        externalId: `portal:${challengeId}`,
        attachments: stored.records,
        requester: { email: input.email, name: input.name },
        ...(hint === null ? {} : { intentKey: hint }),
        ...(priority === undefined ? {} : { priority }),
        customFields: {
          portal: {
            organization: input.organization ?? null,
            organizationMatched: placement.orgId !== null,
            category: input.category,
            urgency: input.urgency ?? null,
            requesterVerified: false,
            urgencyCapped: priority !== undefined && priority !== wanted,
            affectedRequestIds: input.affectedRequestIds ?? [],
            locale: input.locale ?? null,
          },
        },
      });
      const ticketKey = this.keys.format(result.ticket.number);
      if (!result.duplicate) {
        await this.notifier.confirmation(tx, result.ticket, ticketKey);
        await this.audit.recordInTransaction(tx, {
          actor: { type: 'anonymous', id: null },
          action: AUDIT_ACTIONS.portalTicketSubmit,
          targetType: 'ticket',
          targetId: result.ticket.id,
          metadata: {
            category: input.category,
            organizationMatched: placement.orgId !== null,
            emailTag: this.tags.tag(input.email),
            affectedRequestIdCount: input.affectedRequestIds?.length ?? 0,
            attachmentCount: stored.records.length,
            attachmentBytes: stored.bytes,
          },
        });
      }
      return { ticket: result.ticket, ticketKey, duplicate: result.duplicate };
    });
  }

  /** Audits why a proof was refused and answers 400 `verification_failed` (the reason stays in the audit log). */
  private refuse(email: string, reason: VerificationFailure): never {
    AuditScope.set({
      action: AUDIT_ACTIONS.portalVerificationFailed,
      outcome: 'denied',
      targetType: 'email',
      targetId: this.tags.tag(email),
      metadata: { reason, provider: this.verification.name },
    });
    throw verificationFailed();
  }

  /**
   * The organization this address belongs to: the one its contact already has, else the one that
   * claimed its domain (`CLIENT_ORG_RESOLVER`, the same lookup as client sign-in), else none.
   * An address that already is a contact keeps its organization, which also keeps this endpoint
   * from answering "that address belongs to another organization" to a stranger.
   */
  private async place(email: string): Promise<{ orgId: string | null; limitSubject: string }> {
    const known = await this.contacts.findByEmail(this.database.db, email);
    if (known) {
      const [org] = await this.database.db
        .select({ id: schema.organization.id, status: schema.organization.status })
        .from(schema.organization)
        .where(eq(schema.organization.id, known.orgId))
        .limit(1);
      if (org?.status === 'active') return { orgId: org.id, limitSubject: `org:${org.id}` };
    }
    const resolved = known ? null : await this.domains.resolveOrgId(email);
    if (resolved !== null) return { orgId: resolved, limitSubject: `org:${resolved}` };
    // No organization yet: the limit follows the address's domain, so strangers do not share one bucket.
    return { orgId: null, limitSubject: `domain:${emailDomain(email) ?? 'unknown'}` };
  }

  private async ensureUnmatchedOrg(tx: DbTransaction): Promise<string> {
    await tx
      .insert(schema.organization)
      .values({ id: UNMATCHED_ORG_ID, name: UNMATCHED_ORG_NAME })
      .onConflictDoNothing();
    return UNMATCHED_ORG_ID;
  }

  /** The category's intent when this instance has an active one by that key; null files the ticket unclassified. */
  private async activeIntentKey(tx: DbTransaction, key: string): Promise<string | null> {
    const [row] = await tx
      .select({ key: schema.intent.key })
      .from(schema.intent)
      .where(and(eq(schema.intent.key, key), eq(schema.intent.isActive, true)))
      .limit(1);
    return row?.key ?? null;
  }
}
