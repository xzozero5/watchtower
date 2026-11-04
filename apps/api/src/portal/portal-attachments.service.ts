import { createHash, randomUUID } from 'node:crypto';

import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ObjectStoreError, type ObjectStore } from '@watchtower/channels';
import type { Database } from '@watchtower/db';
import { AUDIT_ACTIONS, type PortalAttachment } from '@watchtower/shared';

import { AuditScope } from '../audit/audit-scope.js';
import { ApiHttpError } from '../auth/http-errors.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { OBJECT_STORE } from '../storage/storage.module.js';
import {
  AttachmentRefused,
  checkAttachments,
  type AttachmentRefusal,
  type CheckedAttachment,
} from './portal-attachment-check.js';

/** One uploaded file as multer (memory storage) hands it over. */
export interface UploadedFile {
  readonly originalname: string;
  readonly buffer: Buffer;
}

/** The checked files of a request, not yet stored. */
export interface PreparedAttachments {
  readonly files: readonly CheckedAttachment[];
}

export interface StoredAttachments {
  /** The records for `message.attachments`: the shape of `InboundAttachment`, the same as mail and LINE media. */
  readonly records: readonly Record<string, unknown>[];
  /** What the customer sees back: name and size. */
  readonly view: readonly PortalAttachment[];
  readonly keys: readonly string[];
  readonly bytes: number;
}

const MESSAGES: Readonly<Record<AttachmentRefusal, string>> = {
  too_many_files: 'Too many files',
  empty_file: 'A file is empty',
  file_too_large: 'A file is larger than the limit',
  total_too_large: 'The files together are larger than the limit',
  extension_not_allowed: 'This type of file is not accepted',
  content_not_allowed: 'The content of a file is not an accepted type',
  content_mismatch: 'The content of a file does not match its name',
  active_content: 'A file contains web page or script content',
};

/** The refusal as the API answers it: 413 for sizes, 400 for the rest. `code` is always `attachment_rejected`. */
export function attachmentRejected(reason: AttachmentRefusal, index: number | null): ApiHttpError {
  const tooBig =
    reason === 'file_too_large' || reason === 'total_too_large' || reason === 'too_many_files';
  const where = index === null ? '' : ` (file ${String(index + 1)})`;
  AuditScope.set({
    action: AUDIT_ACTIONS.portalAttachmentRejected,
    outcome: 'denied',
    metadata: { reason, index },
  });
  return new ApiHttpError(
    tooBig ? HttpStatus.PAYLOAD_TOO_LARGE : HttpStatus.BAD_REQUEST,
    'attachment_rejected',
    `${MESSAGES[reason]}${where}`,
  );
}

/**
 * Portal uploads (R-9.1, R-9.3, T-140): checks the bytes, writes them to the object store under
 * random keys, and returns records in the model mail and LINE media already use
 * (`message.attachments`, `InboundAttachment`). Nothing here trusts the client's name or MIME type.
 */
@Injectable()
export class PortalAttachmentsService {
  constructor(
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APP_CONFIG) private readonly config: Pick<ApiConfig, 'PORTAL_UPLOAD_DAILY_MB'>,
  ) {}

  /** Checks the files; a refusal is audited and answered 400/413 before anything is stored. */
  prepare(files: readonly UploadedFile[]): PreparedAttachments {
    try {
      return {
        files: checkAttachments(
          files.map((file) => ({ originalName: file.originalname, bytes: file.buffer })),
        ),
      };
    } catch (error) {
      if (error instanceof AttachmentRefused) throw attachmentRejected(error.reason, error.index);
      throw error;
    }
  }

  /**
   * The instance-wide cap on what customers may upload in 24 hours (`PORTAL_UPLOAD_DAILY_MB`, T-155):
   * 429 `upload_quota` when these files would go past it. Counted from the portal files already on
   * messages in the last day, so there is no counter to drift. 0 = no cap.
   */
  async assertQuota(prepared: PreparedAttachments): Promise<void> {
    const incoming = prepared.files.reduce((sum, file) => sum + file.size, 0);
    const capBytes = this.config.PORTAL_UPLOAD_DAILY_MB * 1024 * 1024;
    if (capBytes === 0 || incoming === 0) return;
    const result = await this.database.pool.query<{ used: string }>(
      `SELECT COALESCE(SUM((a ->> 'size')::bigint), 0)::text AS used
         FROM message m
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(m.attachments) = 'array' THEN m.attachments ELSE '[]'::jsonb END
         ) AS a
        WHERE m.created_at > now() - interval '24 hours'
          AND a ->> 'partId' LIKE 'portal-%'
          AND (a ->> 'size') ~ '^[0-9]+$'`,
    );
    const used = Number(result.rows[0]?.used ?? '0');
    if (used + incoming > capBytes) {
      AuditScope.set({
        action: AUDIT_ACTIONS.portalAttachmentRejected,
        outcome: 'denied',
        metadata: { reason: 'upload_quota' },
      });
      throw new ApiHttpError(
        HttpStatus.TOO_MANY_REQUESTS,
        'upload_quota',
        'File uploads are paused for today; send your message without files or try again tomorrow',
      );
    }
  }

  /**
   * Writes the files. Keys are random (`attachments/portal/<yyyy>/<mm>/<uuid>`): no part of the name
   * or the ticket is guessable or controlled by the sender. A failure part-way deletes what was
   * written and answers 503; the caller can try again.
   */
  async put(prepared: PreparedAttachments, now: Date = new Date()): Promise<StoredAttachments> {
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const keys: string[] = [];
    const records: Record<string, unknown>[] = [];
    try {
      for (const [index, file] of prepared.files.entries()) {
        const key = `attachments/portal/${String(now.getUTCFullYear())}/${month}/${randomUUID()}`;
        await this.store.put(key, file.bytes, file.contentType);
        keys.push(key);
        records.push({
          partId: `portal-${String(index + 1)}`,
          filename: file.fileName,
          contentType: file.contentType,
          size: file.size,
          sha256: createHash('sha256').update(file.bytes).digest('hex'),
          objectKey: key,
          disposition: 'attachment',
          contentId: null,
          referencedByHtml: false,
        });
      }
    } catch (error) {
      await this.discard(keys);
      if (error instanceof ObjectStoreError) {
        this.logger.error({ err: error }, 'portal upload could not be stored');
        throw new ApiHttpError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'storage_unavailable',
          'Attachments cannot be saved right now; try again in a moment',
        );
      }
      throw error;
    }
    return {
      records,
      view: prepared.files.map((file) => ({ name: file.fileName, size: file.size })),
      keys,
      bytes: prepared.files.reduce((sum, file) => sum + file.size, 0),
    };
  }

  /** Best-effort removal of objects whose message was not saved. Never throws. */
  async discard(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.store.delete(key);
      } catch (error) {
        this.logger.warn({ err: error }, 'orphaned portal upload could not be deleted');
      }
    }
  }
}
