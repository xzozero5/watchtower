import {
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  STAFF_UPLOAD_FIELD,
  STAFF_UPLOAD_LIMITS,
  STAFF_UPLOAD_MAX_BYTES,
  staffAttachmentSchema,
  uploadIdParamSchema,
  type UploadIdParam,
} from '@watchtower/shared';
import type { Response } from 'express';

import { AuditScope } from '../audit/audit-scope.js';
import {
  Audited,
  CurrentPrincipal,
  RequireAnyPermission,
  type Principal,
} from '../auth/decorators.js';
import { badRequest, forbidden } from '../auth/http-errors.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { parseResponse } from '../common/zod-openapi.js';
import { attachmentDisposition } from '../tickets/ticket-attachments.controller.js';
import { StaffUploadsService } from './staff-uploads.service.js';

/** Types a browser can show without running anything; anything else is handed out as an opaque download. */
const SAFE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
]);

/**
 * Who writes things that carry files: everyone who may create or handle a ticket, leave a shift
 * note, write or acknowledge a handoff, or work an incident. Clients (organization-scoped users) are
 * refused in the handler: they use the portal. A developer (`ticket.dev.work` only) is left out on
 * purpose: they read tickets with personal data masked (T-137) and a picture cannot be masked, the
 * same reason they cannot download a ticket's attachments.
 */
const WRITERS = [
  'ticket.create',
  'ticket.handle',
  'ticket.reply',
  'shift.note.write',
  'handoff.write',
  'handoff.ack',
  'incident.create',
] as const;

function assertStaff(principal: Principal): void {
  if (principal.orgScope.kind === 'org') throw forbidden();
}

/**
 * Staff uploads: `POST /v1/uploads` stores one file and answers a reference (`id`), which the caller
 * sends with the text it belongs to (`attachmentIds`); `GET /v1/uploads/{id}` hands the file back to a
 * signed-in person. No storage URL is ever returned. Always `Content-Disposition: attachment` with
 * `nosniff` and a sandboxing CSP; the page shows images by fetching them with the session and using a blob URL.
 */
@ApiTags('uploads')
@Controller('v1/uploads')
export class UploadsController {
  constructor(
    @Inject(StaffUploadsService) private readonly uploads: StaffUploadsService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  @Post()
  @RequireAnyPermission(...WRITERS)
  @Audited({ action: AUDIT_ACTIONS.uploadCreate, targetType: 'upload' })
  @UseInterceptors(
    FileInterceptor(STAFF_UPLOAD_FIELD, {
      limits: { fileSize: STAFF_UPLOAD_MAX_BYTES, files: 1, fields: 0, parts: 2 },
    }),
  )
  @ApiOperation({
    summary: 'Upload one image or file to attach to a ticket, note, handoff or incident note',
    description:
      `multipart/form-data with one file in "${STAFF_UPLOAD_FIELD}" (at most ` +
      `${String(STAFF_UPLOAD_MAX_BYTES / 1024 / 1024)} MB; png, jpg, gif, webp, pdf, txt, csv, log). ` +
      'The type is decided from the file bytes (400 attachment_rejected otherwise, 413 for size); ' +
      'EXIF/GPS metadata of a JPEG is removed. The answer is a reference: send its id as ' +
      'attachmentIds with the text. A file can only be attached by the person who uploaded it. ' +
      `At most ${String(STAFF_UPLOAD_LIMITS.perUserPerHour)} an hour per person.`,
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: [STAFF_UPLOAD_FIELD],
      properties: { [STAFF_UPLOAD_FIELD]: { type: 'string', format: 'binary' } },
    },
  })
  @ApiCreatedResponse({ standardSchema: staffAttachmentSchema })
  @ApiBadRequestResponse({ description: 'attachment_rejected' })
  async upload(
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    assertStaff(principal);
    if (file === undefined) throw badRequest('Send one file in the "file" field');
    await this.limiter.enforce(
      'staff-upload',
      principal.userId,
      STAFF_UPLOAD_LIMITS.perUserPerHour,
      3600,
    );
    const attachment = await this.uploads.upload(principal.userId, file);
    AuditScope.set({
      targetId: attachment.id,
      metadata: { contentType: attachment.contentType, size: attachment.size },
    });
    return parseResponse(staffAttachmentSchema, attachment);
  }

  @Get(':id')
  @RequireAnyPermission(...WRITERS)
  @Audited({ action: AUDIT_ACTIONS.uploadDownload, targetType: 'upload', always: true })
  @ApiOperation({
    summary: 'Download an uploaded file',
    description:
      'Needs a signed-in staff session; an organization-scoped client gets 403. Always ' +
      'Content-Disposition: attachment with X-Content-Type-Options: nosniff. The ids are random ' +
      'and only appear on notes, handoffs, incident timelines and tickets the caller can read.',
  })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ description: 'The file bytes' })
  @ApiNotFoundResponse({ description: 'No such file' })
  async download(
    @Param({ schema: uploadIdParamSchema }) params: UploadIdParam,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    assertStaff(principal);
    AuditScope.set({ targetId: params.id });
    const file = await this.uploads.read(params.id);
    const base = file.contentType.toLowerCase();
    const contentType = SAFE_TYPES.has(base)
      ? base.startsWith('text/')
        ? `${base}; charset=utf-8`
        : base
      : 'application/octet-stream';
    response.set({
      'Content-Type': contentType,
      'Content-Disposition': attachmentDisposition(file.filename),
      'Content-Length': String(file.bytes.length),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(file.bytes);
  }
}
