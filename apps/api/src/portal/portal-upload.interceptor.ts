import {
  HttpException,
  Inject,
  Injectable,
  PayloadTooLargeException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  PORTAL_ATTACHMENT_MAX_BYTES,
  PORTAL_ATTACHMENT_MAX_FILES,
  PORTAL_ATTACHMENT_MAX_TOTAL_BYTES,
  PORTAL_MULTIPART_FILES_FIELD,
} from '@watchtower/shared';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

import { badRequest } from '../auth/http-errors.js';
import { attachmentRejected } from './portal-attachments.service.js';
import { PortalLimits } from './portal-limits.js';

/** Room for the multipart framing and the `payload` field on top of the files. */
const OVERHEAD_BYTES = 512 * 1024;

/**
 * Reads a multipart body into memory for the portal's submit and reply routes (T-140). A JSON
 * request passes through untouched. Before a byte of a multipart body is read: the upload rate limit
 * of the client address, and the declared length against the total limit. While it is read, multer
 * stops at the per-file size, the file count and the number of fields, so a request cannot grow
 * without bound. Multer's own errors are turned into the api's `attachment_rejected` answers.
 *
 * Files are held in memory (at most `PORTAL_ATTACHMENT_MAX_TOTAL_BYTES` plus one file in the worst
 * case) and are not written to disk, so there is nothing to clean up if the request is refused.
 */
@Injectable()
export class PortalUploadInterceptor implements NestInterceptor {
  private readonly multipart = new (FilesInterceptor(
    PORTAL_MULTIPART_FILES_FIELD,
    PORTAL_ATTACHMENT_MAX_FILES,
    {
      limits: {
        fileSize: PORTAL_ATTACHMENT_MAX_BYTES,
        files: PORTAL_ATTACHMENT_MAX_FILES,
        // `payload` only. A few spare names would let a client park bytes in fields we ignore.
        fields: 1,
        fieldSize: 200_000,
        parts: PORTAL_ATTACHMENT_MAX_FILES + 1,
      },
    },
  ))();

  constructor(@Inject(PortalLimits) private readonly limits: PortalLimits) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.is('multipart/form-data')) return next.handle();

    const declared = Number(request.headers['content-length']);
    if (
      !Number.isFinite(declared) ||
      declared > PORTAL_ATTACHMENT_MAX_TOTAL_BYTES + OVERHEAD_BYTES
    ) {
      // A chunked body without a length is refused too: every browser form post has one.
      throw attachmentRejected('total_too_large', null);
    }
    await this.limits.enforce('upload-ip', request.ip ?? 'unknown');

    try {
      return await this.multipart.intercept(context, next);
    } catch (error) {
      if (error instanceof PayloadTooLargeException)
        throw attachmentRejected('file_too_large', null);
      if (error instanceof HttpException) {
        const message = error.message;
        if (/unexpected file field|too many (files|parts)/i.test(message)) {
          throw attachmentRejected('too_many_files', null);
        }
        throw badRequest('The upload could not be read');
      }
      throw error;
    }
  }
}
