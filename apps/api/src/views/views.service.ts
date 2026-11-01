import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  MAX_PERSONAL_VIEWS,
  isUuid,
  SYSTEM_VIEWS,
  SYSTEM_VIEW_ID_PREFIX,
  SYSTEM_VIEW_KEYS,
  savedViewFiltersSchema,
  ticketSortSchema,
  type CreateSavedView,
  type SavedView,
  type SavedViewFilters,
  type SavedViewList,
  type UpdateSavedView,
} from '@watchtower/shared';
import { and, asc, eq, or, sql } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service.js';
import { conflict, forbidden, notFound } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { PG, isPgError } from '../common/db-errors.js';
import { DATABASE } from '../database/database.module.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { TicketReader } from '../tickets/ticket-reader.js';

type ViewRow = typeof schema.savedView.$inferSelect;

const canShare = (principal: Principal): boolean => principal.permissions.has('view.share');

/** Filters read back from the database; a row written by an older shape degrades to "no filter", not to an error. */
function filtersOf(value: unknown): SavedViewFilters {
  const parsed = savedViewFiltersSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function sortOf(value: string): SavedView['sort'] {
  const parsed = ticketSortSchema.safeParse(value);
  return parsed.success ? parsed.data : 'created_desc';
}

/**
 * Saved views (T-119a, PRD R-1.8, UI spec 4.2): the built-in ones (code) plus the ones people saved,
 * personal or shared with the team. A view is a set of ticket filters and a sort; it carries no
 * ticket data, so seeing a shared view shows nobody anything they could not list themselves. The
 * counts are computed for the person asking (`assignee: me` is them), by the same filters the
 * ticket list applies.
 */
@Injectable()
export class ViewsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(TicketReader) private readonly reader: TicketReader,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
  ) {}

  private toView(
    row: ViewRow,
    ownerName: string | null,
    principal: Principal,
    count: number | null,
  ): SavedView {
    const owner = row.ownerId === principal.userId;
    return {
      id: row.id,
      kind: row.shared ? 'shared' : 'personal',
      key: null,
      name: row.name,
      filters: filtersOf(row.filters),
      sort: sortOf(row.sort),
      ownerId: row.ownerId,
      ownerName,
      count,
      editable: row.shared ? canShare(principal) : owner,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(principal: Principal, withCounts: boolean): Promise<SavedViewList> {
    const { savedView, users } = schema;
    const rows = await this.database.db
      .select({ row: savedView, ownerName: users.name })
      .from(savedView)
      .innerJoin(users, eq(users.id, savedView.ownerId))
      .where(or(eq(savedView.shared, true), eq(savedView.ownerId, principal.userId)))
      .orderBy(sql`${savedView.shared} DESC`, asc(sql`lower(${savedView.name})`), asc(savedView.id));

    const system: SavedView[] = SYSTEM_VIEW_KEYS.map((key) => {
      const definition = SYSTEM_VIEWS[key];
      return {
        id: `${SYSTEM_VIEW_ID_PREFIX}${key}`,
        kind: 'system' as const,
        key,
        name: definition.name,
        filters: definition.filters,
        sort: definition.sort,
        ownerId: null,
        ownerName: null,
        count: null,
        editable: false,
        createdAt: null,
        updatedAt: null,
      };
    });
    const saved = rows.map(({ row, ownerName }) => this.toView(row, ownerName, principal, null));
    const items = [...system, ...saved];
    if (!withCounts) return { items };
    const counts = await Promise.all(
      items.map((view) => this.reader.count(view.filters, principal)),
    );
    return { items: items.map((view, index) => ({ ...view, count: counts[index] ?? null })) };
  }

  /** One saved view the principal may see (a shared one, or their own); 404 for anyone else's personal view. */
  private async find(tx: Pick<Database['db'], 'select'>, id: string, principal: Principal) {
    const { savedView, users } = schema;
    if (id.startsWith(SYSTEM_VIEW_ID_PREFIX)) throw conflict('Built-in views cannot be changed');
    if (!isUuid(id)) throw notFound('No such view');
    const [found] = await tx
      .select({ row: savedView, ownerName: users.name })
      .from(savedView)
      .innerJoin(users, eq(users.id, savedView.ownerId))
      .where(
        and(
          eq(savedView.id, id),
          or(eq(savedView.shared, true), eq(savedView.ownerId, principal.userId)),
        ),
      )
      .limit(1);
    if (!found) throw notFound('No such view');
    return found;
  }

  async create(input: CreateSavedView, principal: Principal): Promise<SavedView> {
    if (input.shared && !canShare(principal)) {
      throw forbidden('Sharing a view with the team needs the view.share permission');
    }
    try {
      return await this.uow.run(async ({ tx }) => {
        if (!input.shared) {
          const [mine] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.savedView)
            .where(
              and(
                eq(schema.savedView.ownerId, principal.userId),
                eq(schema.savedView.shared, false),
              ),
            );
          if ((mine?.n ?? 0) >= MAX_PERSONAL_VIEWS) {
            throw conflict(`You can keep up to ${String(MAX_PERSONAL_VIEWS)} views`);
          }
        }
        const [row] = await tx
          .insert(schema.savedView)
          .values({
            ownerId: principal.userId,
            name: input.name,
            shared: input.shared,
            filters: input.filters,
            sort: input.sort,
          })
          .returning();
        if (!row) throw new Error('saved_view insert returned no row');
        const view = this.toView(row, principal.name, principal, null);
        await this.audit.recordInTransaction(tx, {
          actor: { type: 'user', id: principal.userId },
          action: AUDIT_ACTIONS.viewCreate,
          targetType: 'saved_view',
          targetId: row.id,
          after: snapshot(view),
        });
        return view;
      });
    } catch (error) {
      throw translate(error);
    }
  }

  async update(id: string, patch: UpdateSavedView, principal: Principal): Promise<SavedView> {
    try {
      return await this.uow.run(async ({ tx }) => {
        const { row: before, ownerName } = await this.find(tx, id, principal);
        // A shared view is the team's: its owner does not get to change it alone, and sharing or
        // unsharing is a team decision too.
        if ((before.shared || patch.shared === true) && !canShare(principal)) {
          throw forbidden('Changing a shared view needs the view.share permission');
        }
        if (before.ownerId !== principal.userId && !before.shared) throw notFound('No such view');
        const [row] = await tx
          .update(schema.savedView)
          .set({
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.filters === undefined ? {} : { filters: patch.filters }),
            ...(patch.sort === undefined ? {} : { sort: patch.sort }),
            ...(patch.shared === undefined ? {} : { shared: patch.shared }),
            updatedAt: sql`now()`,
          })
          .where(eq(schema.savedView.id, before.id))
          .returning();
        if (!row) throw notFound('No such view');
        const view = this.toView(row, ownerName, principal, null);
        await this.audit.recordInTransaction(tx, {
          actor: { type: 'user', id: principal.userId },
          action: AUDIT_ACTIONS.viewUpdate,
          targetType: 'saved_view',
          targetId: row.id,
          before: snapshot(this.toView(before, ownerName, principal, null)),
          after: snapshot(view),
        });
        return view;
      });
    } catch (error) {
      throw translate(error);
    }
  }

  async remove(id: string, principal: Principal): Promise<void> {
    await this.uow.run(async ({ tx }) => {
      const { row: before, ownerName } = await this.find(tx, id, principal);
      if (before.shared && !canShare(principal)) {
        throw forbidden('Deleting a shared view needs the view.share permission');
      }
      await tx.delete(schema.savedView).where(eq(schema.savedView.id, before.id));
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'user', id: principal.userId },
        action: AUDIT_ACTIONS.viewDelete,
        targetType: 'saved_view',
        targetId: before.id,
        before: snapshot(this.toView(before, ownerName, principal, null)),
      });
    });
  }
}

/** What goes on the audit log about a view: its definition, not who looked at it. */
function snapshot(view: SavedView): Record<string, unknown> {
  return {
    name: view.name,
    kind: view.kind,
    shared: view.kind === 'shared',
    filters: view.filters,
    sort: view.sort,
  };
}

function translate(error: unknown): unknown {
  if (isPgError(error, PG.uniqueViolation)) return conflict('A view with that name already exists');
  return error;
}
