import { Controller, Get, Inject, Param, Res, StreamableFile } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { schema, type Database } from '@watchtower/db';
import { ObjectStoreError, type ObjectStore } from '@watchtower/channels';
import { AUDIT_ACTIONS, ticketAttachmentParamSchema } from '@watchtower/shared';
import { and, eq } from 'drizzle-orm';
import type { Response } from 'express';
import type { z } from 'zod';

import { AuditScope } from '../audit/audit-scope.js';
import {
  Audited,
  CurrentPrincipal,
  RequireAnyPermission,
  type Principal,
} from '../auth/decorators.js';
import { ApiHttpError, notFound } from '../auth/http-errors.js';
import { DATABASE } from '../database/database.module.js';
import { sanitizeFileName } from '../portal/portal-attachment-check.js';
import { OBJECT_STORE } from '../storage/storage.module.js';
import { TicketReader, isClient } from './ticket-reader.js';

type AttachmentParam = z.infer<typeof ticketAttachmentParamSchema>;

/**
 * Types a browser can show without running anything. Everything else, whatever a sender's mail said
 * it was (`text/html`, `image/svg+xml`, `application/xhtml+xml`), is handed out as an opaque download.
 */
const SAFE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
]);

/** `Content-Disposition: attachment` with an ASCII fallback and the real name as RFC 5987 `filename*`. */
export function attachmentDisposition(rawName: string): string {
  const name = sanitizeFileName(rawName);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%;]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Download of a file attached to a message: portal uploads, Gmail attachments and LINE media, all
 * stored the same way (`message.attachments`, `objectKey`). The ticket is looked up the way every
 * ticket read is (organization scope, 404 for a ticket the caller cannot see), a client only
 * reaches public messages, and a masked reader (a developer) gets no files at all because a file
 * cannot be masked. The file is always a download, never shown inline.
 */
@ApiTags('tickets')
@Controller('v1/tickets')
export class TicketAttachmentsController {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(TicketReader) private readonly reader: TicketReader,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  @Get(':id/messages/:messageId/attachments/:index')
  @RequireAnyPermission('ticket.read', 'ticket.read.org')
  // A file can hold anything the customer sent: every download is on the audit log.
  @Audited({ action: AUDIT_ACTIONS.ticketAttachmentDownload, targetType: 'ticket', always: true })
  @ApiOperation({
    summary: 'Download one attachment of a message',
    description:
      'Always `Content-Disposition: attachment` with `X-Content-Type-Options: nosniff` and a ' +
      'sandboxing CSP; the content type is the stored one when it is an image, PDF or plain text, ' +
      '`application/octet-stream` otherwise. 404 for a ticket, message or file the caller may not ' +
      'see. Masked readers (`ticket.read.masked`) cannot download files.',
  })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ description: 'The file bytes' })
  @ApiNotFoundResponse({ description: 'No such ticket, message or attachment' })
  @ApiServiceUnavailableResponse({ description: 'Object storage did not answer' })
  async download(
    @Param({ schema: ticketAttachmentParamSchema }) params: AttachmentParam,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const view = await this.reader.viewById(params.id, principal);
    const ticketId = view.t.id;
    AuditScope.set({ targetId: ticketId });
    const [message] = await this.database.db
      .select({
        attachments: schema.message.attachments,
        visibility: schema.message.visibility,
      })
      .from(schema.message)
      .where(and(eq(schema.message.id, params.messageId), eq(schema.message.ticketId, ticketId)))
      .limit(1);
    if (!message || (isClient(principal) && message.visibility !== 'public')) {
      throw notFound('No such attachment');
    }
    const list: unknown[] = Array.isArray(message.attachments) ? message.attachments : [];
    const record = list[params.index];
    const objectKey =
      typeof record === 'object' && record !== null && 'objectKey' in record
        ? record.objectKey
        : null;
    if (typeof objectKey !== 'string' || objectKey === '') {
      // Described but never stored (too large, or fetching failed): nothing to hand out.
      throw notFound('No such attachment');
    }
    const meta = record as { filename?: unknown; contentType?: unknown };

    let bytes: Uint8Array | null;
    try {
      bytes = await this.store.get(objectKey);
    } catch (error) {
      if (error instanceof ObjectStoreError) {
        throw new ApiHttpError(
          503,
          'storage_unavailable',
          'The file cannot be read right now; try again in a moment',
        );
      }
      throw error;
    }
    if (bytes === null) throw notFound('No such attachment');

    const declared = typeof meta.contentType === 'string' ? meta.contentType.toLowerCase() : '';
    const baseType = declared.split(';')[0]?.trim() ?? '';
    const contentType = SAFE_TYPES.has(baseType)
      ? baseType.startsWith('text/')
        ? `${baseType}; charset=utf-8`
        : baseType
      : 'application/octet-stream';
    response.set({
      'Content-Type': contentType,
      'Content-Disposition': attachmentDisposition(
        typeof meta.filename === 'string'
          ? meta.filename
          : `attachment-${String(params.index + 1)}`,
      ),
      'Content-Length': String(bytes.length),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    });
    AuditScope.set({ metadata: { messageId: params.messageId, index: params.index } });
    return new StreamableFile(bytes);
  }
}
