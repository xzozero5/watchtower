import {
  HttpException,
  HttpStatus,
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
  PORTAL_TOKEN_HEADER,
} from '@watchtower/shared';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';

import { ApiHttpError, badRequest } from '../auth/http-errors.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { attachmentRejected } from './portal-attachments.service.js';
import { PortalLimits } from './portal-limits.js';
import { PortalTrackingService } from './portal-tracking.service.js';
import { UploadSlots } from './upload-slots.js';

/** Room for the multipart framing and the `payload` field on top of the files. */
const OVERHEAD_BYTES = 512 * 1024;
/** Suggested wait, in seconds, when every upload slot is taken. */
const BUSY_RETRY_AFTER_SECONDS = 5;
/** The whole body must arrive within this many idle periods, however steadily it trickles in. */
const DEADLINE_IDLE_PERIODS = 4;

/**
 * Reads a multipart body into memory for the portal's submit and reply routes (T-140). A JSON
 * request passes through untouched. The body is buffered before the proof of work (submit) or the
 * handler's own checks, so everything that can be decided without reading it is decided first, in
 * this order:
 *   1. the declared length against the total limit (no `Content-Length`: refused);
 *   2. an upload slot (`UploadSlots`: a few in flight per process, one per client address), else
 *      503 + Retry-After; the slot is given back when the response ends or the connection closes;
 *   3. the upload rate limit of the client address;
 *   4. on a reply, the tracking token for this ticket (401 before a byte of the body is read);
 *   5. an inactivity timeout and an overall deadline on the connection while the body is read, so
 *      a slow sender cannot pin memory and a slot.
 * While the body is read, multer stops at the per-file size, the file count and the number of
 * fields. Multer's own errors become the api's `attachment_rejected` answers.
 *
 * Files are held in memory and not written to disk, so there is nothing to clean up if the request
 * is refused.
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
  private readonly slots: UploadSlots;
  private readonly idleMs: number;

  constructor(
    @Inject(PortalLimits) private readonly limits: PortalLimits,
    @Inject(PortalTrackingService) private readonly tracking: PortalTrackingService,
    @Inject(APP_CONFIG) config: ApiConfig,
  ) {
    this.slots = new UploadSlots(
      config.PORTAL_UPLOAD_MAX_CONCURRENT,
      config.PORTAL_UPLOAD_MAX_PER_ADDRESS,
    );
    this.idleMs = config.PORTAL_UPLOAD_IDLE_SECONDS * 1000;
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.is('multipart/form-data')) return next.handle();
    const response = context.switchToHttp().getResponse<Response>();
    const address = request.ip ?? 'unknown';

    const declared = Number(request.headers['content-length']);
    if (
      !Number.isFinite(declared) ||
      declared > PORTAL_ATTACHMENT_MAX_TOTAL_BYTES + OVERHEAD_BYTES
    ) {
      // A chunked body without a length is refused too: every browser form post has one.
      throw attachmentRejected('total_too_large', null);
    }

    const release = this.slots.acquire(address);
    if (release === null) {
      response.setHeader('Retry-After', String(BUSY_RETRY_AFTER_SECONDS));
      throw new ApiHttpError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'upload_busy',
        'Too many uploads are being received right now; try again in a few seconds',
      );
    }
    // `close` fires when the response is done and when the client goes away.
    response.once('close', release);
    const socket = request.socket;
    const onIdle = (): void => {
      request.destroy();
    };
    const deadline = setTimeout(onIdle, this.idleMs * DEADLINE_IDLE_PERIODS);
    try {
      await this.limits.enforce('upload-ip', address);
      const key = (request.params as Record<string, string | undefined>).key;
      if (key !== undefined) {
        const token = request.headers[PORTAL_TOKEN_HEADER];
        await this.tracking.authorize(typeof token === 'string' ? token : undefined, key, address);
      }

      socket.setTimeout(this.idleMs);
      socket.once('timeout', onIdle);
      return await this.multipart.intercept(context, next);
    } catch (error) {
      release();
      if (error instanceof PayloadTooLargeException)
        throw attachmentRejected('file_too_large', null);
      if (error instanceof HttpException && !(error instanceof ApiHttpError)) {
        const message = error.message;
        if (/unexpected file field|too many (files|parts)/i.test(message)) {
          throw attachmentRejected('too_many_files', null);
        }
        throw badRequest('The upload could not be read');
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      socket.off('timeout', onIdle);
      socket.setTimeout(0);
    }
  }
}
