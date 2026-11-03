import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { assertAssignableStaff } from '@watchtower/domain';
import {
  AUDIT_ACTIONS,
  NOTE_NEXT_SHIFT_TTL_HOURS,
  type CreateShiftNote,
  type NoteAudience,
  type ShiftNote,
  type ShiftNotePage,
  type ShiftNoteQuery,
  type StaffAttachment,
  staffAttachmentSchema,
} from '@watchtower/shared';
import { and, desc, eq, gte, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { notFound } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { beforeCursor, decodeCursor, preciseTimestamp, toPage } from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';
import { translating } from '../domain/domain-errors.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { StaffUploadsService } from '../uploads/staff-uploads.service.js';
import { SHIFT_NOW, type Executor, type ShiftNow } from './shift-core.js';

const author = alias(schema.users, 'note_author');
const recipient = alias(schema.users, 'note_recipient');
const { shiftNote: note, shiftNoteRead: read } = schema;

/**
 * What a person can see in their inbox at `now` (R-7.7): notes to them, notes to the next shift
 * written by someone else within the last 48 hours, and notes for a date and time that has come
 * (to them, or to nobody in particular). Never their own, unless another person's note names them.
 */
export function inboxCondition(userId: string, now: Date): SQL {
  const horizon = new Date(now.getTime() - NOTE_NEXT_SHIFT_TTL_HOURS * 3_600_000);
  return or(
    and(eq(note.audience, 'person'), eq(note.toUserId, userId)),
    and(eq(note.audience, 'next_shift'), ne(note.authorId, userId), gte(note.createdAt, horizon)),
    and(
      eq(note.audience, 'datetime'),
      lte(note.deliverAt, now),
      or(isNull(note.toUserId), eq(note.toUserId, userId)),
      or(ne(note.authorId, userId), eq(note.toUserId, userId)),
    ),
  ) as SQL;
}

/** Shift notes: leave one, read one's inbox, mark read (R-7.7). */
@Injectable()
export class ShiftNotes {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SHIFT_NOW) private readonly now: ShiftNow,
    @Inject(StaffUploadsService) private readonly uploads: StaffUploadsService,
  ) {}

  /** Unread notes in the person's inbox: the badge on the shift chip. */
  async unreadCount(executor: Executor, userId: string): Promise<number> {
    const [row] = await executor
      .select({ n: sql<number>`count(*)::int` })
      .from(note)
      .leftJoin(read, and(eq(read.noteId, note.id), eq(read.userId, userId)))
      .where(and(inboxCondition(userId, this.now()), isNull(read.readAt)));
    return row?.n ?? 0;
  }

  /** Unread inbox notes of a person, newest first (for the brief). */
  async unread(executor: Executor, userId: string, limit = 50): Promise<ShiftNote[]> {
    const rows = await this.query(executor, userId)
      .where(and(inboxCondition(userId, this.now()), isNull(read.readAt)))
      .orderBy(desc(note.createdAt), desc(note.id))
      .limit(limit);
    return rows.map(toNote);
  }

  async list(principal: Principal, query: ShiftNoteQuery): Promise<ShiftNotePage> {
    const db = this.database.db;
    const userId = principal.userId;
    const rows = await this.query(db, userId)
      .where(
        and(
          query.box === 'inbox' ? inboxCondition(userId, this.now()) : eq(note.authorId, userId),
          query.unread ? isNull(read.readAt) : undefined,
          query.cursor === undefined
            ? undefined
            : beforeCursor(note.createdAt, note.id, decodeCursor(query.cursor)),
        ),
      )
      .orderBy(desc(note.createdAt), desc(note.id))
      .limit(query.limit + 1);
    const page = toPage(
      rows.map((row) => ({ row, id: row.n.id, sortKey: row.sortKey })),
      query.limit,
    );
    return {
      items: page.rows.map((entry) => toNote(entry.row)),
      nextCursor: page.nextCursor,
      unreadCount: await this.unreadCount(db, userId),
    };
  }

  async create(principal: Principal, input: CreateShiftNote): Promise<ShiftNote> {
    const attachments = await this.uploads.claim(principal.userId, input.attachmentIds);
    return this.uow.run(async (uow) => {
      if (input.toUserId !== undefined) {
        await translating(() => assertAssignableStaff(uow.tx, [input.toUserId as string]));
      }
      const [created] = await uow.tx
        .insert(note)
        .values({
          authorId: principal.userId,
          audience: input.audience,
          toUserId: input.toUserId ?? null,
          deliverAt: input.deliverAt === undefined ? null : new Date(input.deliverAt),
          body: input.body,
          attachments,
          createdAt: this.now(),
        })
        .returning({ id: note.id });
      if (created === undefined) throw new Error('insert returned nothing');
      await this.audit.recordInTransaction(uow.tx, {
        actor: { type: 'user', id: principal.userId },
        action: AUDIT_ACTIONS.shiftNoteCreate,
        targetType: 'shift_note',
        targetId: created.id,
        metadata: {
          audience: input.audience,
          toUserId: input.toUserId ?? null,
          deliverAt: input.deliverAt ?? null,
          attachments: attachments.length,
        },
      });
      return this.one(uow.tx, principal.userId, created.id);
    });
  }

  /** Marks a note of the caller's inbox read. A note that is not theirs looks like a missing one. */
  async markRead(principal: Principal, noteId: string): Promise<ShiftNote> {
    return this.uow.run(async (uow) => {
      const [visible] = await uow.tx
        .select({ id: note.id })
        .from(note)
        .where(and(eq(note.id, noteId), inboxCondition(principal.userId, this.now())))
        .limit(1);
      if (visible === undefined) throw notFound('No such note');
      const inserted = await uow.tx
        .insert(read)
        .values({ noteId, userId: principal.userId, readAt: this.now() })
        .onConflictDoNothing()
        .returning({ noteId: read.noteId });
      await this.audit.recordInTransaction(uow.tx, {
        actor: { type: 'user', id: principal.userId },
        action: AUDIT_ACTIONS.shiftNoteRead,
        targetType: 'shift_note',
        targetId: noteId,
        metadata: { firstRead: inserted.length > 0 },
      });
      return this.one(uow.tx, principal.userId, noteId);
    });
  }

  private async one(executor: Executor, userId: string, id: string): Promise<ShiftNote> {
    const [row] = await this.query(executor, userId).where(eq(note.id, id)).limit(1);
    if (row === undefined) throw notFound('No such note');
    return toNote(row);
  }

  private query(executor: Executor, userId: string) {
    return executor
      .select({
        n: note,
        authorName: author.name,
        toName: recipient.name,
        readAt: read.readAt,
        sortKey: preciseTimestamp(note.createdAt),
      })
      .from(note)
      .innerJoin(author, eq(author.id, note.authorId))
      .leftJoin(recipient, eq(recipient.id, note.toUserId))
      .leftJoin(read, and(eq(read.noteId, note.id), eq(read.userId, userId)))
      .$dynamic();
  }
}

interface NoteRow {
  readonly n: typeof note.$inferSelect;
  readonly authorName: string;
  readonly toName: string | null;
  readonly readAt: Date | null;
}

/** References stored as jsonb, checked on the way out so a bad row cannot break the page. */
export function parseAttachments(value: unknown): StaffAttachment[] {
  const parsed = z.array(staffAttachmentSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

function toNote(row: NoteRow): ShiftNote {
  return {
    id: row.n.id,
    audience: row.n.audience as NoteAudience,
    author: { id: row.n.authorId, name: row.authorName },
    toUser:
      row.n.toUserId !== null && row.toName !== null
        ? { id: row.n.toUserId, name: row.toName }
        : null,
    deliverAt: row.n.deliverAt?.toISOString() ?? null,
    body: row.n.body,
    attachments: parseAttachments(row.n.attachments),
    createdAt: row.n.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}
