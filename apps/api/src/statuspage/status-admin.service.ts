import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import type { Actor } from '@watchtower/domain';
import type {
  CreateStatusComponent,
  CreateStatusMaintenance,
  CreateStatusPost,
  DraftFromIncident,
  StatusComponent,
  StatusMaintenanceStaff,
  StatusPostListQuery,
  StatusPostStaff,
  UpdateStatusComponent,
  UpdateStatusMaintenance,
  UpdateStatusPost,
} from '@watchtower/shared';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';

import { forbidden, notFound } from '../auth/http-errors.js';
import { decodeCursor, encodeCursor } from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';
import { domainContext, settle } from '../domain/domain-context.js';
import { translating } from '../domain/domain-errors.js';
import { DOMAIN, type Domain } from '../domain/domain.module.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';

type PostRow = typeof schema.statusPost.$inferSelect;
type WindowRow = typeof schema.statusMaintenance.$inferSelect;

const iso = (date: Date): string => date.toISOString();

/**
 * Staff side of the status page: components, posts and maintenance windows. Reads shape rows into staff DTOs
 * (they do carry the drafter, the publisher and the incident link: staff only). Writes go through
 * `@watchtower/domain`, which refuses a publication that is not a person's and writes the audit row.
 */
@Injectable()
export class StatusAdminService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
  ) {}

  // --- components --------------------------------------------------------------------------------

  async listComponents(): Promise<StatusComponent[]> {
    const rows = await this.database.db
      .select()
      .from(schema.statusComponent)
      .orderBy(schema.statusComponent.position, schema.statusComponent.name);
    return rows.map((row) => this.toComponent(row));
  }

  async createComponent(actor: Actor, input: CreateStatusComponent): Promise<StatusComponent> {
    const { id } = await translating(() =>
      this.uow.run(async (uow) =>
        settle(uow, await this.domain.statusPage.createComponent(uow.tx, this.ctx(actor), input)),
      ),
    );
    return this.component(id);
  }

  async updateComponent(
    actor: Actor,
    id: string,
    input: UpdateStatusComponent,
  ): Promise<StatusComponent> {
    await translating(() =>
      this.uow.run(async (uow) =>
        settle(uow, await this.domain.statusPage.updateComponent(uow.tx, this.ctx(actor), id, input)),
      ),
    );
    return this.component(id);
  }

  async deleteComponent(actor: Actor, id: string): Promise<{ deleted: boolean }> {
    return translating(() =>
      this.uow.run(async (uow) =>
        settle(uow, await this.domain.statusPage.deleteComponent(uow.tx, this.ctx(actor), id)),
      ),
    );
  }

  private async component(id: string): Promise<StatusComponent> {
    const [row] = await this.database.db
      .select()
      .from(schema.statusComponent)
      .where(eq(schema.statusComponent.id, id))
      .limit(1);
    if (row === undefined) throw notFound('No such component');
    return this.toComponent(row);
  }

  private toComponent(row: typeof schema.statusComponent.$inferSelect): StatusComponent {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      serviceId: row.serviceId,
      public: row.public,
      position: row.position,
      status: row.status as StatusComponent['status'],
    };
  }

  // --- posts -------------------------------------------------------------------------------------

  async listPosts(
    query: StatusPostListQuery,
  ): Promise<{ items: StatusPostStaff[]; nextCursor: string | null }> {
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const rows = await this.database.db
      .select({
        post: schema.statusPost,
        key: sql<string>`to_char(${schema.statusPost.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(schema.statusPost)
      .where(
        and(
          query.state === undefined ? undefined : eq(schema.statusPost.state, query.state),
          cursor === undefined
            ? undefined
            : or(
                lt(schema.statusPost.createdAt, sql`${cursor.v}::timestamptz`),
                and(
                  eq(schema.statusPost.createdAt, sql`${cursor.v}::timestamptz`),
                  lt(schema.statusPost.id, cursor.id),
                ),
              ),
        ),
      )
      .orderBy(desc(schema.statusPost.createdAt), desc(schema.statusPost.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: await this.toPosts(page.map((row) => row.post)),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ v: last.key, id: last.post.id })
          : null,
    };
  }

  async getPost(id: string): Promise<StatusPostStaff> {
    const [row] = await this.database.db
      .select()
      .from(schema.statusPost)
      .where(eq(schema.statusPost.id, id))
      .limit(1);
    if (row === undefined) throw notFound('No such post');
    const [post] = await this.toPosts([row]);
    if (post === undefined) throw notFound('No such post');
    return post;
  }

  async draftPost(actor: Actor, input: CreateStatusPost): Promise<StatusPostStaff> {
    const { id } = await translating(() =>
      this.uow.run(async (uow) =>
        settle(uow, await this.domain.statusPage.draftPost(uow.tx, this.ctx(actor), input)),
      ),
    );
    return this.getPost(id);
  }

  async draftFromIncident(actor: Actor, input: DraftFromIncident): Promise<StatusPostStaff> {
    const { id } = await translating(() =>
      this.uow.run(async (uow) =>
        settle(
          uow,
          await this.domain.statusPage.draftPostFromIncident(uow.tx, this.ctx(actor), input),
        ),
      ),
    );
    return this.getPost(id);
  }

  /** A public post is edited by someone who may publish (`incident.manage`); a draft by anyone who may draft. */
  async updatePost(
    actor: Actor,
    id: string,
    input: UpdateStatusPost,
    mayPublish: boolean,
  ): Promise<StatusPostStaff> {
    const existing = await this.getPost(id);
    if (existing.state === 'published' && !mayPublish) {
      throw forbidden('Changing a published post needs permission to publish');
    }
    await translating(() =>
      this.uow.run(async (uow) =>
        settle(uow, await this.domain.statusPage.updatePost(uow.tx, this.ctx(actor), id, input)),
      ),
    );
    return this.getPost(id);
  }

  async publishPost(
    actor: Actor,
    id: string,
  ): Promise<{ post: StatusPostStaff; subscribers: number }> {
    const { subscribers } = await translating(() =>
      this.uow.run(async (uow) =>
        settle(uow, await this.domain.statusPage.publishPost(uow.tx, this.ctx(actor), id)),
      ),
    );
    return { post: await this.getPost(id), subscribers };
  }

  async deletePost(actor: Actor, id: string): Promise<{ deleted: boolean }> {
    return translating(() =>
      this.uow.run(async (uow) =>
        settle(uow, await this.domain.statusPage.deletePostDraft(uow.tx, this.ctx(actor), id)),
      ),
    );
  }

  private async toPosts(rows: readonly PostRow[]): Promise<StatusPostStaff[]> {
    if (rows.length === 0) return [];
    const links = await this.database.db
      .select()
      .from(schema.statusPostComponent)
      .where(inArray(schema.statusPostComponent.postId, rows.map((row) => row.id)));
    return rows.map((row) => ({
      id: row.id,
      incidentId: row.incidentId,
      title: row.title,
      body: row.body,
      phase: row.phase as StatusPostStaff['phase'],
      impact: row.impact as StatusPostStaff['impact'],
      state: row.state as StatusPostStaff['state'],
      origin: row.origin as StatusPostStaff['origin'],
      draftedBy: row.draftedBy,
      publishedBy: row.publishedBy,
      publishedAt: row.publishedAt === null ? null : iso(row.publishedAt),
      componentIds: links.filter((link) => link.postId === row.id).map((link) => link.componentId),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    }));
  }

  // --- maintenance -------------------------------------------------------------------------------

  async listMaintenance(): Promise<StatusMaintenanceStaff[]> {
    const rows = await this.database.db
      .select()
      .from(schema.statusMaintenance)
      .orderBy(desc(schema.statusMaintenance.startsAt))
      .limit(100);
    return this.toWindows(rows);
  }

  async getMaintenance(id: string): Promise<StatusMaintenanceStaff> {
    const [row] = await this.database.db
      .select()
      .from(schema.statusMaintenance)
      .where(eq(schema.statusMaintenance.id, id))
      .limit(1);
    if (row === undefined) throw notFound('No such maintenance window');
    const [window] = await this.toWindows([row]);
    if (window === undefined) throw notFound('No such maintenance window');
    return window;
  }

  async draftMaintenance(actor: Actor, input: CreateStatusMaintenance) {
    const { id } = await translating(() =>
      this.uow.run(async (uow) =>
        settle(uow, await this.domain.statusPage.draftMaintenance(uow.tx, this.ctx(actor), input)),
      ),
    );
    return this.getMaintenance(id);
  }

  async updateMaintenance(
    actor: Actor,
    id: string,
    input: UpdateStatusMaintenance,
    mayPublish: boolean,
  ) {
    const existing = await this.getMaintenance(id);
    if (existing.state === 'published' && !mayPublish) {
      throw forbidden('Changing a published maintenance window needs permission to publish');
    }
    await translating(() =>
      this.uow.run(async (uow) =>
        settle(
          uow,
          await this.domain.statusPage.updateMaintenance(uow.tx, this.ctx(actor), id, input),
        ),
      ),
    );
    return this.getMaintenance(id);
  }

  async publishMaintenance(actor: Actor, id: string) {
    const { subscribers } = await translating(() =>
      this.uow.run(async (uow) =>
        settle(uow, await this.domain.statusPage.publishMaintenance(uow.tx, this.ctx(actor), id)),
      ),
    );
    return { maintenance: await this.getMaintenance(id), subscribers };
  }

  async cancelMaintenance(actor: Actor, id: string) {
    await translating(() =>
      this.uow.run(async (uow) =>
        settle(uow, await this.domain.statusPage.cancelMaintenance(uow.tx, this.ctx(actor), id)),
      ),
    );
    return this.getMaintenance(id);
  }

  private async toWindows(rows: readonly WindowRow[]): Promise<StatusMaintenanceStaff[]> {
    if (rows.length === 0) return [];
    const links = await this.database.db
      .select()
      .from(schema.statusMaintenanceComponent)
      .where(
        inArray(
          schema.statusMaintenanceComponent.maintenanceId,
          rows.map((row) => row.id),
        ),
      );
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      startsAt: iso(row.startsAt),
      endsAt: iso(row.endsAt),
      state: row.state as StatusMaintenanceStaff['state'],
      origin: row.origin as StatusMaintenanceStaff['origin'],
      publishedBy: row.publishedBy,
      publishedAt: row.publishedAt === null ? null : iso(row.publishedAt),
      componentIds: links
        .filter((link) => link.maintenanceId === row.id)
        .map((link) => link.componentId),
    }));
  }

  // --- subscribers -------------------------------------------------------------------------------

  /** Counts only: the addresses of readers are not listed, not even to staff. */
  async subscriberSummary(): Promise<{ pending: number; confirmed: number; unsubscribed: number }> {
    const rows = await this.database.db
      .select({
        state: schema.statusSubscription.state,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.statusSubscription)
      .groupBy(schema.statusSubscription.state);
    const count = (state: string): number => rows.find((row) => row.state === state)?.n ?? 0;
    return {
      pending: count('pending'),
      confirmed: count('confirmed'),
      unsubscribed: count('unsubscribed'),
    };
  }

  private ctx(actor: Actor) {
    return domainContext(this.domain, actor);
  }
}
