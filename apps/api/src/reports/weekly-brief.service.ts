import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  latestDraftWeeklyBrief,
  latestPublishedWeeklyBrief,
  toWeeklyBrief,
} from '@watchtower/domain';
import {
  evidenceOutsideDraft,
  weeklyBriefContentSchema,
  weeklyBriefEmailParts,
  type WeeklyBrief,
  type WeeklyBriefContent,
  type WeeklyBriefDraft,
  type WeeklyBriefPublishResult,
  type WeeklyBriefPublished,
} from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import { badRequest, conflict, forbidden, notFound } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { EmailOutbox } from '../queue/queue.module.js';

type Config = Pick<ApiConfig, 'APP_URL' | 'WEEKLY_BRIEF_RECIPIENTS'>;

/** How long a published brief stays worth emailing if the queue cannot deliver it. */
const BRIEF_EMAIL_TTL_SECONDS = 3 * 24 * 3600;

/**
 * The weekly brief of the CEO view (T-305c). The worker drafts it (`weekly_brief` row, `status: draft`); a head
 * edits the words and publishes it; the CEO page shows the newest published one and the recipients get it by
 * email through the outbox (the same path as every other email: `EmailOutbox`, rendered and sent by the worker).
 *
 * - Edit: the words are the head's to change; the evidence is not. A claim may keep the chips the model's own
 *   draft had, drop them, or be a sentence the head wrote with none (shown as `Uncited`); a chip the draft never
 *   had is refused, because nothing read it (N5). The model's text is kept next to the edit.
 * - Publish: one transaction flips the row and queues one email per recipient; a published brief is final (a
 *   database trigger refuses any change). A second publish answers 409 and queues nothing.
 */
@Injectable()
export class WeeklyBriefService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(EmailOutbox) private readonly email: EmailOutbox,
  ) {}

  private requireAll(principal: Principal): void {
    if (principal.orgScope.kind !== 'all') throw forbidden();
  }

  /** The newest published brief: what the CEO page shows. */
  async published(principal: Principal): Promise<WeeklyBriefPublished> {
    this.requireAll(principal);
    const row = await latestPublishedWeeklyBrief(this.database.db);
    return { brief: row === undefined ? null : toWeeklyBrief(row, { includeAi: false }) };
  }

  /** The newest draft, with the model's own text, for the head who edits it. */
  async draft(principal: Principal): Promise<WeeklyBriefDraft> {
    this.requireAll(principal);
    const row = await latestDraftWeeklyBrief(this.database.db);
    return {
      draft: row === undefined ? null : toWeeklyBrief(row, { includeAi: true }),
      defaultRecipients: [...this.config.WEEKLY_BRIEF_RECIPIENTS],
    };
  }

  async edit(id: string, content: WeeklyBriefContent, principal: Principal): Promise<WeeklyBrief> {
    this.requireAll(principal);
    const [row] = await this.database.db
      .select()
      .from(schema.weeklyBrief)
      .where(eq(schema.weeklyBrief.id, id))
      .limit(1);
    if (row === undefined) throw notFound('No such brief');
    if (row.status !== 'draft') throw conflict('A published brief cannot be changed');
    const draft = weeklyBriefContentSchema.parse(row.aiContent);
    const outside = evidenceOutsideDraft(draft, content);
    // `data_only` drafts have the figure claims as their draft: a head may add a sentence of their own, never a chip.
    if (outside.length > 0) {
      throw badRequest('A claim cites evidence that the draft did not have');
    }
    const now = new Date();
    const [updated] = await this.database.db
      .update(schema.weeklyBrief)
      .set({ content, editedBy: principal.userId, editedAt: now, updatedAt: now })
      .where(eq(schema.weeklyBrief.id, id))
      .returning();
    if (updated === undefined) throw conflict('A published brief cannot be changed');
    return toWeeklyBrief(updated, { includeAi: true });
  }

  async publish(
    id: string,
    recipients: readonly string[] | undefined,
    principal: Principal,
  ): Promise<WeeklyBriefPublishResult> {
    this.requireAll(principal);
    const list = [...new Set(recipients ?? this.config.WEEKLY_BRIEF_RECIPIENTS)];
    const pageUrl = new URL('/dashboard/ceo', this.config.APP_URL).toString();
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.weeklyBrief)
        .where(eq(schema.weeklyBrief.id, id))
        .for('update')
        .limit(1);
      if (row === undefined) throw notFound('No such brief');
      if (row.status !== 'draft') throw conflict('This brief is already published');
      const now = new Date();
      const [published] = await tx
        .update(schema.weeklyBrief)
        .set({
          status: 'published',
          publishedBy: principal.userId,
          publishedAt: now,
          recipients: list,
          updatedAt: now,
        })
        .where(eq(schema.weeklyBrief.id, id))
        .returning();
      if (published === undefined) throw conflict('This brief is already published');
      const brief = toWeeklyBrief(published, { includeAi: false });
      const parts = weeklyBriefEmailParts(brief.content);
      for (const to of list) {
        await this.email.send(
          {
            kind: 'weekly_brief',
            to,
            locale: brief.locale,
            periodFrom: brief.periodFrom,
            periodTo: brief.periodTo,
            pageUrl,
            ...parts,
          },
          // One email per brief and address: a retry of the same publish cannot send twice.
          `weekly-brief-${id}-${createHash('sha256').update(to).digest('hex').slice(0, 16)}`,
          tx,
          BRIEF_EMAIL_TTL_SECONDS,
        );
      }
      return { brief, queued: list.length };
    });
  }
}
