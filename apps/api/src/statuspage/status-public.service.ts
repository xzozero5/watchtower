import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  STATUS_HISTORY_DAYS,
  statusEmailLimitKey,
  overallStatus,
  type PublicHistory,
  type PublicMaintenance,
  type PublicPost,
  type PublicStatus,
  type StatusComponentStatus,
  type Subscribe,
} from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';

import { AuditScope } from '../audit/audit-scope.js';
import { ApiHttpError } from '../auth/http-errors.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { domainContext, settle } from '../domain/domain-context.js';
import { translating } from '../domain/domain-errors.js';
import { DOMAIN, type Domain } from '../domain/domain.module.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { StatusLimits } from './status-limits.js';

const ANONYMOUS = { type: 'anonymous', id: null } as const;
const iso = (date: Date): string => date.toISOString();

/**
 * What a visitor of the status page can read, and what they can do (subscribe, confirm, unsubscribe). Every
 * read here selects named columns and builds the public shape field by field: a column added to a table
 * tomorrow does not reach the page. Nothing of an incident (title, commander, root cause, organizations) is
 * in a public table row, and the incident id of a post is not selected at all.
 *
 * Time: what is "ongoing" or "upcoming" or "in the last 90 days" is decided by the database clock.
 */
@Injectable()
export class StatusPublicService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(StatusLimits) private readonly limits: StatusLimits,
    @Inject(APP_CONFIG) config: Pick<ApiConfig, 'APP_ENCRYPTION_KEY'>,
  ) {
    // Its own subkey: a status link can never be a survey link, or the other way round.
    this.linkKey = deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.statusLink);
  }

  private readonly linkKey: Buffer;

  async current(ip: string | null): Promise<PublicStatus> {
    await this.limits.enforce('read-ip', ip ?? 'unknown');
    const db = this.database.db;
    const components = await db
      .select({
        slug: schema.statusComponent.slug,
        name: schema.statusComponent.name,
        description: schema.statusComponent.description,
        status: schema.statusComponent.status,
      })
      .from(schema.statusComponent)
      .where(eq(schema.statusComponent.public, true))
      .orderBy(schema.statusComponent.position, schema.statusComponent.name);

    const postRows = await db
      .select(this.postColumns())
      .from(schema.statusPost)
      .where(and(eq(schema.statusPost.state, 'published'), ne(schema.statusPost.phase, 'resolved')))
      .orderBy(desc(schema.statusPost.publishedAt))
      .limit(20);
    const ongoing = await db
      .select(this.maintenanceColumns())
      .from(schema.statusMaintenance)
      .where(
        and(
          eq(schema.statusMaintenance.state, 'published'),
          sql`${schema.statusMaintenance.startsAt} <= clock_timestamp()`,
          sql`${schema.statusMaintenance.endsAt} > clock_timestamp()`,
        ),
      )
      .orderBy(schema.statusMaintenance.startsAt)
      .limit(20);
    const upcoming = await db
      .select(this.maintenanceColumns())
      .from(schema.statusMaintenance)
      .where(
        and(
          eq(schema.statusMaintenance.state, 'published'),
          sql`${schema.statusMaintenance.startsAt} > clock_timestamp()`,
        ),
      )
      .orderBy(schema.statusMaintenance.startsAt)
      .limit(20);
    const clock = await db.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
    const refs = await this.componentRefs(
      postRows.map((row) => row.id),
      [...ongoing, ...upcoming].map((row) => row.id),
    );
    return {
      overall: overallStatus(
        components.map((component) => component.status as StatusComponentStatus),
      ),
      components: components.map((component) => ({
        slug: component.slug,
        name: component.name,
        description: component.description,
        status: component.status as StatusComponentStatus,
      })),
      activePosts: postRows.map((row) => this.toPost(row, refs.posts.get(row.id) ?? [])),
      ongoingMaintenance: ongoing.map((row) =>
        this.toMaintenance(row, refs.windows.get(row.id) ?? []),
      ),
      upcomingMaintenance: upcoming.map((row) =>
        this.toMaintenance(row, refs.windows.get(row.id) ?? []),
      ),
      generatedAt: iso(new Date(clock.rows[0]?.now ?? Date.now())),
    };
  }

  async history(ip: string | null): Promise<PublicHistory> {
    await this.limits.enforce('read-ip', ip ?? 'unknown');
    const db = this.database.db;
    const postRows = await db
      .select(this.postColumns())
      .from(schema.statusPost)
      .where(
        and(
          eq(schema.statusPost.state, 'published'),
          sql`${schema.statusPost.publishedAt} >= clock_timestamp() - make_interval(days => ${STATUS_HISTORY_DAYS})`,
        ),
      )
      .orderBy(desc(schema.statusPost.publishedAt))
      .limit(200);
    const windows = await db
      .select(this.maintenanceColumns())
      .from(schema.statusMaintenance)
      .where(
        and(
          eq(schema.statusMaintenance.state, 'published'),
          sql`${schema.statusMaintenance.endsAt} <= clock_timestamp()`,
          sql`${schema.statusMaintenance.endsAt} >= clock_timestamp() - make_interval(days => ${STATUS_HISTORY_DAYS})`,
        ),
      )
      .orderBy(desc(schema.statusMaintenance.startsAt))
      .limit(100);
    const refs = await this.componentRefs(
      postRows.map((row) => row.id),
      windows.map((row) => row.id),
    );
    return {
      days: STATUS_HISTORY_DAYS,
      posts: postRows.map((row) => this.toPost(row, refs.posts.get(row.id) ?? [])),
      maintenance: windows.map((row) => this.toMaintenance(row, refs.windows.get(row.id) ?? [])),
    };
  }

  /**
   * Asks to subscribe. Limited per caller and per address, and the answer is the same whether or not the
   * address was known, confirmed, or throttled by the domain.
   */
  async subscribe(input: Subscribe, ip: string | null): Promise<void> {
    await this.limits.enforce('subscribe-ip', ip ?? 'unknown');
    await this.limits.enforce('subscribe-email', statusEmailLimitKey(input.email));
    await translating(() =>
      this.uow.run(async (uow) =>
        settle(
          uow,
          await this.domain.statusPage.requestSubscription(
            uow.tx,
            domainContext(this.domain, ANONYMOUS),
            { email: input.email, locale: input.locale },
          ),
        ),
      ),
    );
  }

  async confirm(token: string, ip: string | null): Promise<void> {
    await this.limits.enforce('link-ip', ip ?? 'unknown');
    const key = this.signingKey();
    const result = await translating(() =>
      this.uow.run(async (uow) =>
        settle(
          uow,
          await this.domain.statusPage.confirmSubscription(
            uow.tx,
            domainContext(this.domain, ANONYMOUS),
            key,
            token,
          ),
        ),
      ),
    );
    AuditScope.set({ targetType: 'status_subscription' });
    if (result.outcome !== 'confirmed') throw this.invalidLink();
  }

  async unsubscribe(token: string, ip: string | null): Promise<void> {
    await this.limits.enforce('link-ip', ip ?? 'unknown');
    const key = this.signingKey();
    const result = await translating(() =>
      this.uow.run(async (uow) =>
        settle(
          uow,
          await this.domain.statusPage.unsubscribe(
            uow.tx,
            domainContext(this.domain, ANONYMOUS),
            key,
            token,
          ),
        ),
      ),
    );
    AuditScope.set({ targetType: 'status_subscription' });
    if (result.outcome !== 'unsubscribed') throw this.invalidLink();
  }

  private signingKey(): Buffer {
    return this.linkKey;
  }

  private invalidLink(): ApiHttpError {
    return new ApiHttpError(400, 'invalid_or_expired_link', 'This link is invalid or has expired');
  }

  private postColumns() {
    return {
      id: schema.statusPost.id,
      title: schema.statusPost.title,
      body: schema.statusPost.body,
      phase: schema.statusPost.phase,
      impact: schema.statusPost.impact,
      publishedAt: schema.statusPost.publishedAt,
      updatedAt: schema.statusPost.updatedAt,
    };
  }

  private maintenanceColumns() {
    return {
      id: schema.statusMaintenance.id,
      title: schema.statusMaintenance.title,
      body: schema.statusMaintenance.body,
      startsAt: schema.statusMaintenance.startsAt,
      endsAt: schema.statusMaintenance.endsAt,
    };
  }

  /** The PUBLIC components each post and window is about; a component that is not public is not named. */
  private async componentRefs(postIds: readonly string[], windowIds: readonly string[]) {
    const db = this.database.db;
    const posts = new Map<string, { slug: string; name: string }[]>();
    const windows = new Map<string, { slug: string; name: string }[]>();
    if (postIds.length > 0) {
      const rows = await db
        .select({
          id: schema.statusPostComponent.postId,
          slug: schema.statusComponent.slug,
          name: schema.statusComponent.name,
        })
        .from(schema.statusPostComponent)
        .innerJoin(
          schema.statusComponent,
          eq(schema.statusComponent.id, schema.statusPostComponent.componentId),
        )
        .where(
          and(
            inArray(schema.statusPostComponent.postId, [...postIds]),
            eq(schema.statusComponent.public, true),
          ),
        )
        .orderBy(schema.statusComponent.position, schema.statusComponent.name);
      for (const row of rows) {
        posts.set(row.id, [...(posts.get(row.id) ?? []), { slug: row.slug, name: row.name }]);
      }
    }
    if (windowIds.length > 0) {
      const rows = await db
        .select({
          id: schema.statusMaintenanceComponent.maintenanceId,
          slug: schema.statusComponent.slug,
          name: schema.statusComponent.name,
        })
        .from(schema.statusMaintenanceComponent)
        .innerJoin(
          schema.statusComponent,
          eq(schema.statusComponent.id, schema.statusMaintenanceComponent.componentId),
        )
        .where(
          and(
            inArray(schema.statusMaintenanceComponent.maintenanceId, [...windowIds]),
            eq(schema.statusComponent.public, true),
          ),
        )
        .orderBy(schema.statusComponent.position, schema.statusComponent.name);
      for (const row of rows) {
        windows.set(row.id, [...(windows.get(row.id) ?? []), { slug: row.slug, name: row.name }]);
      }
    }
    return { posts, windows };
  }

  private toPost(
    row: {
      id: string;
      title: string;
      body: string;
      phase: string;
      impact: string;
      publishedAt: Date | null;
      updatedAt: Date;
    },
    components: { slug: string; name: string }[],
  ): PublicPost {
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      phase: row.phase as PublicPost['phase'],
      impact: row.impact as PublicPost['impact'],
      publishedAt: iso(row.publishedAt ?? row.updatedAt),
      updatedAt: iso(row.updatedAt),
      components,
    };
  }

  private toMaintenance(
    row: { id: string; title: string; body: string; startsAt: Date; endsAt: Date },
    components: { slug: string; name: string }[],
  ): PublicMaintenance {
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      startsAt: iso(row.startsAt),
      endsAt: iso(row.endsAt),
      components,
    };
  }
}
