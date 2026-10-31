import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  type Contact,
  type ContactListQuery,
  type CreateContact,
  type UpdateContact,
} from '@watchtower/shared';
import { and, arrayContains, desc, eq, ilike, or, sql } from 'drizzle-orm';

import { AuditScope, type AuditActor } from '../audit/audit-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { badRequest, conflict, notFound } from '../auth/http-errors.js';
import { PG, isPgError } from '../common/db-errors.js';
import {
  beforeCursor,
  decodeCursor,
  likeContains,
  preciseTimestamp,
  toPage,
} from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';
import type { DbTransaction } from '../realtime/unit-of-work.js';

export type ContactRow = typeof schema.contact.$inferSelect;

export function toApiContact(row: ContactRow): Contact {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    emails: row.emails,
    lineUserId: row.lineUserId,
    phone: row.phone,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    roleInOrg: row.roleInOrg,
    notificationPrefs: (row.notificationPrefs ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The audit log gets ids and counts, not addresses or phone numbers (PII minimization). */
function snapshot(row: ContactRow): Record<string, unknown> {
  return {
    id: row.id,
    orgId: row.orgId,
    emailCount: row.emails.length,
    hasLineUserId: row.lineUserId !== null,
    hasPhone: row.phone !== null,
  };
}

@Injectable()
export class ContactsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(query: ContactListQuery): Promise<{ items: Contact[]; nextCursor: string | null }> {
    const { contact } = schema;
    const text = query.q?.trim();
    const rows = await this.database.db
      .select({ row: contact, sortKey: preciseTimestamp(contact.createdAt) })
      .from(contact)
      .where(
        and(
          query.orgId === undefined ? undefined : eq(contact.orgId, query.orgId),
          text === undefined
            ? undefined
            : or(
                ilike(contact.name, likeContains(text)),
                arrayContains(contact.emails, [text.toLowerCase()]),
              ),
          query.cursor === undefined
            ? undefined
            : beforeCursor(contact.createdAt, contact.id, decodeCursor(query.cursor)),
        ),
      )
      .orderBy(desc(contact.createdAt), desc(contact.id))
      .limit(query.limit + 1);
    const page = toPage(
      rows.map((entry) => ({ ...entry, id: entry.row.id })),
      query.limit,
    );
    return {
      items: page.rows.map((entry) => toApiContact(entry.row)),
      nextCursor: page.nextCursor,
    };
  }

  async get(id: string): Promise<Contact> {
    const row = await this.find(id);
    if (!row) throw notFound('No such contact');
    return toApiContact(row);
  }

  async find(id: string): Promise<ContactRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, id))
      .limit(1);
    return row;
  }

  async create(input: CreateContact): Promise<Contact> {
    try {
      const [row] = await this.database.db
        .insert(schema.contact)
        .values({
          orgId: input.orgId,
          name: input.name,
          emails: input.emails,
          lineUserId: input.lineUserId ?? null,
          phone: input.phone ?? null,
          roleInOrg: input.roleInOrg ?? null,
          notificationPrefs: input.notificationPrefs ?? {},
        })
        .returning();
      if (!row) throw new Error('contact insert returned no row');
      AuditScope.set({ targetType: 'contact', targetId: row.id, after: snapshot(row) });
      return toApiContact(row);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async update(id: string, patch: UpdateContact): Promise<Contact> {
    const before = await this.find(id);
    if (!before) throw notFound('No such contact');
    AuditScope.set({ targetType: 'contact', targetId: id, before: snapshot(before) });
    try {
      const [row] = await this.database.db
        .update(schema.contact)
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.emails === undefined ? {} : { emails: patch.emails }),
          ...(patch.lineUserId === undefined ? {} : { lineUserId: patch.lineUserId }),
          ...(patch.phone === undefined ? {} : { phone: patch.phone }),
          ...(patch.roleInOrg === undefined ? {} : { roleInOrg: patch.roleInOrg }),
          ...(patch.notificationPrefs === undefined
            ? {}
            : { notificationPrefs: patch.notificationPrefs }),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.contact.id, id))
        .returning();
      if (!row) throw notFound('No such contact');
      AuditScope.set({
        after: snapshot(row),
        metadata: { changedFields: Object.keys(patch) },
      });
      return toApiContact(row);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async remove(id: string): Promise<void> {
    const before = await this.find(id);
    if (!before) throw notFound('No such contact');
    AuditScope.set({ targetType: 'contact', targetId: id, before: snapshot(before) });
    try {
      await this.database.db.delete(schema.contact).where(eq(schema.contact.id, id));
    } catch (error) {
      // 0003 made the foreign keys of tickets and messages RESTRICT: history is never rewritten.
      if (isPgError(error, PG.foreignKeyViolation)) {
        throw conflict(
          'The contact is still referenced by tickets or messages and cannot be deleted. ' +
            'Erasing a person (PDPA) is a separate process; edit the contact instead',
        );
      }
      throw error;
    }
  }

  /** The contact that owns `email` in any organization (one mailbox is one contact), if there is one. */
  async findByEmail(
    executor: Pick<Database['db'], 'select'>,
    email: string,
  ): Promise<ContactRow | undefined> {
    const [row] = await executor
      .select()
      .from(schema.contact)
      .where(arrayContains(schema.contact.emails, [email.trim().toLowerCase()]))
      .limit(1);
    return row;
  }

  /**
   * The contact of this organization that owns `email`, created if the address is new. Used when a
   * ticket arrives from a person we have not seen (portal form, a staff member filing on behalf).
   * An address that already belongs to a contact of another organization is a conflict: one mailbox
   * is one contact, and silently moving it would change whose tickets someone sees.
   *
   * A contact it creates gets a `contact.create` audit row in the same transaction (rolled back
   * together with it), attributed to `actor`: creating a person record is never silent.
   */
  async findOrCreateByEmail(
    tx: DbTransaction,
    orgId: string,
    email: string,
    name: string,
    actor: AuditActor,
  ): Promise<ContactRow> {
    const normalized = email.trim().toLowerCase();
    const [existing] = await tx
      .select()
      .from(schema.contact)
      .where(arrayContains(schema.contact.emails, [normalized]))
      .limit(1);
    if (existing) {
      if (existing.orgId !== orgId) {
        throw conflict('This email address belongs to a contact of another organization');
      }
      return existing;
    }
    try {
      // A savepoint: a unique violation must not abort the caller's whole transaction.
      return await tx.transaction(async (savepoint) => {
        const [created] = await savepoint
          .insert(schema.contact)
          .values({ orgId, name, emails: [normalized] })
          .returning();
        if (!created) throw new Error('contact insert returned no row');
        await this.audit.recordInTransaction(savepoint, {
          actor,
          action: AUDIT_ACTIONS.contactCreate,
          targetType: 'contact',
          targetId: created.id,
          after: snapshot(created),
          metadata: { via: 'find_or_create_by_email' },
        });
        return created;
      });
    } catch (error) {
      if (!isPgError(error, PG.uniqueViolation)) throw error;
      // Someone created the same contact a moment ago (two submissions from one new address).
      const [winner] = await tx
        .select()
        .from(schema.contact)
        .where(arrayContains(schema.contact.emails, [normalized]))
        .limit(1);
      if (winner?.orgId === orgId) return winner;
      throw conflict('This email address belongs to another contact');
    }
  }

  private translate(error: unknown): unknown {
    if (isPgError(error, PG.uniqueViolation)) {
      return conflict(
        'An email address or LINE user of this contact already belongs to another contact',
      );
    }
    if (isPgError(error, PG.foreignKeyViolation)) {
      return badRequest('orgId does not refer to an organization');
    }
    return error;
  }
}
