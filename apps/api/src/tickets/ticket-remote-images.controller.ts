import { Controller, Get, Inject, Param, Query, Res, StreamableFile } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { schema, type Database } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  ticketRemoteImageParamSchema,
  ticketRemoteImageQuerySchema,
} from '@watchtower/shared';
import { and, eq } from 'drizzle-orm';
import type { Response } from 'express';
import type { z } from 'zod';

import { AuditScope } from '../audit/audit-scope.js';
import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { ApiHttpError, notFound } from '../auth/http-errors.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { DATABASE } from '../database/database.module.js';
import { EgressError } from '../egress/safe-fetch.js';
import {
  RemoteImageService,
  auditHostOf,
  failureReason,
  remoteImageUrls,
  urlFingerprint,
} from './remote-image.service.js';
import { TicketReader } from './ticket-reader.js';

type RemoteImageParam = z.infer<typeof ticketRemoteImageParamSchema>;
type RemoteImageQuery = z.infer<typeof ticketRemoteImageQuerySchema>;

/** Pictures one person may load per minute (a mail can hold up to 200; opening a few at once is normal). `[ASSUMED]` */
export const REMOTE_IMAGE_PER_USER_PER_MINUTE = 300;

/**
 * "Display images" of the mail reader (T-175). The web app's CSP lets the page load images from itself,
 * `data:` and `blob:` only, so a picture hosted by the sender cannot be shown directly (and should not be:
 * a direct request tells the sender who read the mail, and from where). The browser asks this route for the
 * n-th remote picture of a stored message instead; the api fetches it, with every SSRF guard of
 * `SafeImageFetcher`, and hands back the bytes.
 *
 * Who may ask: people who read tickets in full (`ticket.read`). A client (`ticket.read.org`) never sees the
 * HTML of a mail, and a developer reading masked (`ticket.read.masked`) is refused: an image is a file
 * chosen by a stranger, it cannot be masked (the same reason attachments are closed to them), and a fetch
 * would also tell the sender that someone from this company read the mail.
 */
@ApiTags('tickets')
@Controller('v1/tickets')
export class TicketRemoteImagesController {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(TicketReader) private readonly reader: TicketReader,
    @Inject(RemoteImageService) private readonly images: RemoteImageService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  @Get(':id/messages/:messageId/remote-image')
  @RequirePermission('ticket.read')
  // The api talks to a server the sender chose: every fetch, allowed or refused, is on the audit log
  // (host and a short fingerprint of the address, never the path or query, which can hold a personal token).
  @Audited({ action: AUDIT_ACTIONS.ticketRemoteImageFetch, targetType: 'ticket', always: true })
  @ApiOperation({
    summary: 'Fetch one remote image of an inbound mail through the SSRF-guarded proxy',
    description:
      '`u` is the position of the picture among the `data-remote-src` of the stored message HTML; the ' +
      'address is never taken from the request. https only unless REMOTE_IMAGES_ALLOW_HTTP; private, ' +
      'loopback, link-local and metadata addresses are refused before and after every redirect (at ' +
      'most 3); at most 5 MB; PNG, JPEG, GIF or WebP by content, whatever the sender said. Any refusal or ' +
      'failure upstream is a generic 502. Served with `nosniff` and a sandboxing CSP.',
  })
  @ApiProduces('image/png', 'image/jpeg', 'image/gif', 'image/webp')
  @ApiOkResponse({ description: 'The picture bytes' })
  @ApiNotFoundResponse({ description: 'No such ticket, message or picture' })
  @ApiTooManyRequestsResponse({ description: 'Too many pictures requested' })
  @ApiBadGatewayResponse({ description: 'The picture could not be fetched (or was refused)' })
  async get(
    @Param({ schema: ticketRemoteImageParamSchema }) params: RemoteImageParam,
    @Query({ schema: ticketRemoteImageQuerySchema }) query: RemoteImageQuery,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const view = await this.reader.viewById(params.id, principal);
    const ticketId = view.t.id;
    AuditScope.set({ targetId: ticketId });
    const [message] = await this.database.db
      .select({ bodyHtml: schema.message.bodyHtml })
      .from(schema.message)
      .where(and(eq(schema.message.id, params.messageId), eq(schema.message.ticketId, ticketId)))
      .limit(1);
    if (!message) throw notFound('No such picture');
    const url = remoteImageUrls(message.bodyHtml)[query.u];
    if (url === undefined) throw notFound('No such picture');

    AuditScope.set({
      metadata: {
        messageId: params.messageId,
        index: query.u,
        host: auditHostOf(url),
        urlHash: urlFingerprint(url),
      },
    });
    await this.limiter.enforce(
      'remote-image',
      principal.userId,
      REMOTE_IMAGE_PER_USER_PER_MINUTE,
      60,
    );

    try {
      const { image, fromCache } = await this.images.load(url, principal.userId);
      AuditScope.set({ metadata: { bytes: image.bytes.length, fromCache } });
      response.set({
        'Content-Type': image.contentType,
        'Content-Length': String(image.bytes.length),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, max-age=300',
      });
      return new StreamableFile(image.bytes);
    } catch (error) {
      AuditScope.set({ metadata: { reason: failureReason(error) } });
      if (error instanceof ApiHttpError) throw error;
      if (error instanceof EgressError) {
        throw new ApiHttpError(502, 'remote_image_unavailable', 'The picture could not be loaded');
      }
      throw error;
    }
  }
}
