import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  OTHER_MAIL_DISPOSITIONS,
  inboundClassificationSchema,
  type ChannelType,
  type ConvertOtherMail,
  type ConvertOtherMailResult,
  type OtherMailDetail,
  type OtherMailDisposition,
  type OtherMailItem,
  type OtherMailQuery,
} from '@watchtower/shared';
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';

import type { AuditActor } from '../audit/audit-scope.js';
import { notFound } from '../auth/http-errors.js';
import {
  beforeCursor,
  decodeCursor,
  likeContains,
  preciseTimestamp,
  toPage,
} from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';
import { domainContext, settle } from '../domain/domain-context.js';
import { translating } from '../domain/domain-errors.js';
import { DOMAIN, type Domain } from '../domain/domain.module.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';

type Row = typeof schema.inboundMessage.$inferSelect;

const SNIPPET_LENGTH = 200;

const isOtherMail = (value: string): value is OtherMailDisposition =>
  (OTHER_MAIL_DISPOSITIONS as readonly string[]).includes(value);

/** The first `SNIPPET_LENGTH` characters (code points, so Thai is not split), one line. */
function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const characters = Array.from(flat);
  return characters.length <= SNIPPET_LENGTH
    ? flat
    : `${characters.slice(0, SNIPPET_LENGTH - 1).join('')}…`;
}

function toItem(row: Row, channel: ChannelType): OtherMailItem {
  const classification = inboundClassificationSchema.safeParse(row.classification);
  const automated = row.automated as { disposition?: unknown; subtype?: unknown };
  const attachments: unknown = row.attachments;
  return {
    id: row.id,
    channelAccountId: row.channelAccountId,
    channel,
    // The list only selects the three dispositions, so this never falls through.
    disposition: isOtherMail(row.disposition) ? row.disposition : 'noise',
    classification: classification.success
      ? {
          type: classification.data.type,
          confidence: classification.data.confidence,
          source: classification.data.source,
        }
      : null,
    automatedSubtype:
      automated.disposition !== 'human' && typeof automated.subtype === 'string'
        ? automated.subtype
        : null,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    subject: row.subject,
    snippet: snippetOf(row.bodyText),
    attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
    receivedAt: row.receivedAt.toISOString(),
  };
}

/**
 * "Other mail" (PRD R-2.6, R-2.7, UI spec section 7): received messages the system did not turn into a
 * ticket (noise, automatic replies, internal mail), and "this is a ticket" for the ones it got wrong
 * (T-119, found missing in T-109). Reading is staff work behind `inbound.read`; the address and text
 * are personal data, so the routes write `pii.read` audit rows.
 */
@Injectable()
export class OtherMailService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
  ) {}

  async list(
    query: OtherMailQuery,
  ): Promise<{ items: OtherMailItem[]; nextCursor: string | null }> {
    const { inboundMessage, channelAccount } = schema;
    const dispositions = query.disposition ?? [...OTHER_MAIL_DISPOSITIONS];
    const pattern = query.q === undefined ? undefined : likeContains(query.q);
    const conditions: (SQL | undefined)[] = [
      inArray(inboundMessage.disposition, dispositions),
      query.channelAccountId === undefined
        ? undefined
        : eq(inboundMessage.channelAccountId, query.channelAccountId),
      pattern === undefined
        ? undefined
        : or(
            ilike(inboundMessage.fromAddress, pattern),
            ilike(inboundMessage.fromName, pattern),
            ilike(inboundMessage.subject, pattern),
            ilike(sql`left(${inboundMessage.bodyText}, ${SNIPPET_LENGTH})`, pattern),
          ),
      query.cursor === undefined
        ? undefined
        : beforeCursor(inboundMessage.receivedAt, inboundMessage.id, decodeCursor(query.cursor)),
    ];
    const rows = await this.database.db
      .select({
        row: inboundMessage,
        channel: channelAccount.type,
        sortKey: preciseTimestamp(inboundMessage.receivedAt),
      })
      .from(inboundMessage)
      .innerJoin(channelAccount, eq(channelAccount.id, inboundMessage.channelAccountId))
      .where(and(...conditions))
      .orderBy(desc(inboundMessage.receivedAt), desc(inboundMessage.id))
      .limit(query.limit + 1);
    const page = toPage(
      rows.map((entry) => ({ id: entry.row.id, sortKey: entry.sortKey, entry })),
      query.limit,
    );
    return {
      items: page.rows.map(({ entry }) => toItem(entry.row, entry.channel as ChannelType)),
      nextCursor: page.nextCursor,
    };
  }

  /** One message with its whole text. 404 once it is not in Other mail any more (it became a ticket). */
  async get(id: string): Promise<OtherMailDetail> {
    const { inboundMessage, channelAccount } = schema;
    const [found] = await this.database.db
      .select({ row: inboundMessage, channel: channelAccount.type })
      .from(inboundMessage)
      .innerJoin(channelAccount, eq(channelAccount.id, inboundMessage.channelAccountId))
      .where(
        and(
          eq(inboundMessage.id, id),
          inArray(inboundMessage.disposition, [...OTHER_MAIL_DISPOSITIONS]),
        ),
      )
      .limit(1);
    if (!found) throw notFound('No such message in Other mail');
    return { ...toItem(found.row, found.channel as ChannelType), bodyText: found.row.bodyText };
  }

  async convert(
    id: string,
    input: ConvertOtherMail,
    actor: AuditActor,
  ): Promise<ConvertOtherMailResult> {
    const outcome = await translating(() =>
      this.uow.run(async (uow) =>
        settle(
          uow,
          await this.domain.inbound.convert(uow.tx, domainContext(this.domain, actor), {
            inboundMessageId: id,
            priority: input.priority,
            intentKey: input.intentKey,
          }),
        ),
      ),
    );
    return {
      inboundMessageId: outcome.inboundMessageId,
      ticketId: outcome.ticketId,
      ticketKey: outcome.ticketKey,
      convertedFrom: outcome.convertedFrom,
    };
  }
}
