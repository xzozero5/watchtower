import { randomBytes } from 'node:crypto';

import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  CUSTOMER_STATUS_LABELS,
  DEFAULT_PORTAL_LOCALE,
  PORTAL_MY_REQUESTS_LIMIT,
  PORTAL_MY_REQUESTS_LINK_MINUTES,
  PORTAL_MY_REQUESTS_PATH,
  PORTAL_TOKEN_FRAGMENT_KEY,
  customerStatus,
  emailDomain,
  maskEmail,
  portalLocaleSchema,
  type PortalLocale,
  type PortalMyRequestItem,
  type PortalMyRequestsView,
  type TicketStatus,
} from '@watchtower/shared';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service.js';
import { EmailTagService } from '../audit/email-tag.service.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { ContactsService } from '../orgs/contacts.service.js';
import { TICKET_KEYS, type TicketKeys } from '../tickets/ticket-keys.js';
import { PortalLimits, type PortalLimitScope } from './portal-limits.js';
import { PortalNotifier } from './portal-notifier.js';
import { PortalTokensService } from './portal-tokens.service.js';
import { hashToken } from './portal-tokens.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Longest header value we even hash: the real token is 49 characters. */
const MAX_PRESENTED = 512;

/** `wtl1.` + 256 random bits. Nothing is signed: the database row (its hash) is the proof we issued it. */
function mintListToken(): string {
  return `wtl1.${randomBytes(32).toString('base64url')}`;
}

/** The address as it is stored and counted: trimmed and lower-cased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function contactLocale(preferences: unknown): PortalLocale | undefined {
  const parsed = portalLocaleSchema.safeParse(
    typeof preferences === 'object' && preferences !== null && 'locale' in preferences
      ? preferences.locale
      : undefined,
  );
  return parsed.success ? parsed.data : undefined;
}

/**
 * "Email me a link to my requests" (T-152), the customer who lost their tracking links.
 *
 * Asking: the controller has already checked the address's own limit and the proof of work; `request`
 * returns at once and does the rest after the response, so the response and its timing are the same
 * whether or not the address belongs to a contact, was limited, or the mail was written. The email,
 * domain and global limits drop a request silently. An address that is no contact gets nothing and
 * no account is created, ever.
 *
 * Opening: the link works once and for `PORTAL_MY_REQUESTS_LINK_MINUTES`. It lists the tickets of the
 * contact that owns the address (not of the whole organization: that view needs a sign-in, R-9.4),
 * read-only, with what the tracking page already shows. Each open ticket comes with its own tracking
 * token so the row opens the page; a closed ticket does not (its links were revoked on purpose).
 * One failure answer for every reason.
 */
@Injectable()
export class PortalMyRequestsService implements OnApplicationShutdown {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PortalLimits) private readonly limits: PortalLimits,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(PortalNotifier) private readonly notifier: PortalNotifier,
    @Inject(PortalTokensService) private readonly tokens: PortalTokensService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EmailTagService) private readonly tags: EmailTagService,
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  /** Starts the work and returns; the caller answers 202 without waiting for it. */
  request(email: string, locale: PortalLocale | undefined, ip: string | null): void {
    const work = this.issue(normalizeEmail(email), locale, ip).catch((error: unknown) => {
      this.logger.error({ err: error }, 'portal my-requests link failed');
    });
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  /** Resolves when every request started so far has finished (tests, shutdown). */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.whenIdle();
  }

  private async issue(email: string, locale: PortalLocale | undefined, ip: string | null) {
    const emailTag = this.tags.tag(email);
    // Cheapest and most specific first; the global ceiling is counted last so a request already
    // refused for its address does not use up what everyone else shares.
    const scopes: readonly (readonly [PortalLimitScope, string])[] = [
      ['mine-email', email],
      ['mine-domain', emailDomain(email) ?? 'unknown'],
      ['mine-global', 'all'],
    ];
    for (const [scope, subject] of scopes) {
      const hit = await this.limits.hit(scope, subject);
      if (!hit.allowed) {
        await this.audit.record({
          actor: { type: 'anonymous', id: null },
          action: AUDIT_ACTIONS.portalRateLimited,
          outcome: 'denied',
          targetType: 'email',
          targetId: emailTag,
          ip,
          metadata: { scope, flow: 'my_requests', retryAfterSeconds: hit.retryAfterSeconds },
        });
        return;
      }
    }

    const contact = await this.contacts.findByEmail(this.database.db, email);
    // A retired placeholder (merged into another contact) is nobody's inbox.
    if (!contact || contact.mergedIntoContactId !== null) return;

    const token = mintListToken();
    const now = Date.now();
    const expiresAt = new Date(now + PORTAL_MY_REQUESTS_LINK_MINUTES * MINUTE_MS);
    const url = new URL(PORTAL_MY_REQUESTS_PATH, this.config.APP_URL);
    // The fragment never reaches a server or a log; the page reads it and sends it in a header.
    url.hash = `${PORTAL_TOKEN_FRAGMENT_KEY}=${token}`;

    await this.database.db.transaction(async (tx) => {
      // Asking again voids the link before: one live link per contact. A week-old row is housekeeping.
      await tx
        .update(schema.portalListLink)
        .set({ consumedAt: sql`now()` })
        .where(
          and(
            eq(schema.portalListLink.contactId, contact.id),
            isNull(schema.portalListLink.consumedAt),
          ),
        );
      await tx
        .delete(schema.portalListLink)
        .where(
          and(
            eq(schema.portalListLink.contactId, contact.id),
            lt(schema.portalListLink.expiresAt, new Date(now - DAY_MS)),
          ),
        );
      await tx.insert(schema.portalListLink).values({
        contactId: contact.id,
        emailTag,
        tokenHash: hashToken(token),
        expiresAt,
      });
      await this.notifier.myRequestsLink(
        tx,
        {
          email,
          locale: locale ?? contactLocale(contact.notificationPrefs) ?? DEFAULT_PORTAL_LOCALE,
        },
        url.toString(),
        PORTAL_MY_REQUESTS_LINK_MINUTES,
      );
      await this.audit.record(
        {
          actor: { type: 'anonymous', id: contact.id },
          action: AUDIT_ACTIONS.portalMyRequestsIssued,
          targetType: 'contact',
          targetId: contact.id,
          ip,
          metadata: { emailTag },
        },
        tx,
      );
    });
  }

  /**
   * Spends the link and lists the contact's tickets, in one transaction: if listing fails the link is
   * not spent. Returns null for every reason the link does not work (unknown, used, expired, voided,
   * the contact no longer owns the address).
   */
  async open(token: string | undefined): Promise<{
    readonly contactId: string;
    readonly emailTag: string;
    readonly view: PortalMyRequestsView;
  } | null> {
    // Hashed and looked up even for something that cannot be ours, so every failure costs the same.
    const presented = (token ?? '').slice(0, MAX_PRESENTED);
    return this.database.db.transaction(async (tx) => {
      const [link] = await tx
        .update(schema.portalListLink)
        .set({ consumedAt: sql`now()` })
        .where(
          and(
            eq(schema.portalListLink.tokenHash, hashToken(presented)),
            isNull(schema.portalListLink.consumedAt),
            gt(schema.portalListLink.expiresAt, sql`now()`),
          ),
        )
        .returning({
          contactId: schema.portalListLink.contactId,
          emailTag: schema.portalListLink.emailTag,
        });
      if (!link) return null;

      const [contact] = await tx
        .select({
          emails: schema.contact.emails,
          mergedIntoContactId: schema.contact.mergedIntoContactId,
        })
        .from(schema.contact)
        .where(eq(schema.contact.id, link.contactId))
        .limit(1);
      // Bound to the address: if the contact no longer owns it, the link is worth nothing.
      const address = contact?.emails.find(
        (candidate) => this.tags.tag(candidate) === link.emailTag,
      );
      if (!contact || contact.mergedIntoContactId !== null || address === undefined) return null;

      const rows = await tx
        .select({
          id: schema.ticket.id,
          number: schema.ticket.number,
          subject: schema.ticket.subject,
          status: schema.ticket.status,
          createdAt: schema.ticket.createdAt,
          updatedAt: schema.ticket.updatedAt,
        })
        .from(schema.ticket)
        .where(eq(schema.ticket.requesterContactId, link.contactId))
        .orderBy(desc(schema.ticket.updatedAt), desc(schema.ticket.id))
        .limit(PORTAL_MY_REQUESTS_LIMIT + 1);

      const items: PortalMyRequestItem[] = [];
      for (const row of rows.slice(0, PORTAL_MY_REQUESTS_LIMIT)) {
        const status = customerStatus(row.status as TicketStatus);
        items.push({
          key: this.keys.format(row.number),
          subject: row.subject,
          status,
          statusLabel: CUSTOMER_STATUS_LABELS[status],
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          // A closed ticket's links were revoked on purpose (C-13): it is listed, not opened from here.
          trackingToken:
            status === 'closed'
              ? null
              : (await this.tokens.issue(tx, row.id, link.contactId)).token,
        });
      }
      return {
        contactId: link.contactId,
        emailTag: link.emailTag,
        view: {
          maskedEmail: maskEmail(address),
          items,
          truncated: rows.length > PORTAL_MY_REQUESTS_LIMIT,
        },
      };
    });
  }
}
