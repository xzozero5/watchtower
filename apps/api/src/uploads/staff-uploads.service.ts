import { createHash, randomUUID } from 'node:crypto';

import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ObjectStoreError, type ObjectStore } from '@watchtower/channels';
import { schema, type Database } from '@watchtower/db';
import { STAFF_ATTACHMENTS_MAX, type StaffAttachment } from '@watchtower/shared';
import { and, eq, inArray } from 'drizzle-orm';

import { ApiHttpError, badRequest, notFound } from '../auth/http-errors.js';
import { DATABASE } from '../database/database.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import {
  AttachmentRefused,
  checkAttachments,
  detectKind,
} from '../portal/portal-attachment-check.js';
import { attachmentRejected, type UploadedFile } from '../portal/portal-attachments.service.js';
import { OBJECT_STORE } from '../storage/storage.module.js';
import { stripMetadata } from './strip-metadata.js';

export interface StoredFile {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

type UploadRow = typeof schema.staffUpload.$inferSelect;

export function toAttachment(row: UploadRow): StaffAttachment {
  return { id: row.id, filename: row.filename, contentType: row.contentType, size: row.size };
}

/**
 * Files that signed-in staff attach to what they write (tickets, shift notes, handoffs, incident
 * notes). The checks are the portal's (`checkAttachments`: size, extension, the type decided from the
 * bytes, no markup in text files); on top of that the EXIF/GPS metadata of a JPEG and the text chunks of
 * a PNG are dropped before the file is stored. Keys are random; nothing about a file is reachable by URL.
 */
@Injectable()
export class StaffUploadsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  async upload(
    userId: string,
    file: UploadedFile,
    now: Date = new Date(),
  ): Promise<StaffAttachment> {
    let checked;
    try {
      [checked] = checkAttachments([{ originalName: file.originalname, bytes: file.buffer }]);
    } catch (error) {
      if (error instanceof AttachmentRefused) throw attachmentRejected(error.reason, error.index);
      throw error;
    }
    if (checked === undefined) throw badRequest('No file');
    const kind = detectKind(checked.bytes);
    const bytes = kind === null ? checked.bytes : stripMetadata(kind, checked.bytes);

    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const key = `attachments/staff/${String(now.getUTCFullYear())}/${month}/${randomUUID()}`;
    try {
      await this.store.put(key, bytes, checked.contentType);
    } catch (error) {
      if (error instanceof ObjectStoreError) {
        this.logger.error({ err: error }, 'staff upload could not be stored');
        throw new ApiHttpError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'storage_unavailable',
          'The file cannot be saved right now; try again in a moment',
        );
      }
      throw error;
    }
    try {
      const [row] = await this.database.db
        .insert(schema.staffUpload)
        .values({
          uploaderId: userId,
          objectKey: key,
          filename: checked.fileName,
          contentType: checked.contentType,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          createdAt: now,
        })
        .returning();
      if (row === undefined) throw new Error('insert returned nothing');
      return toAttachment(row);
    } catch (error) {
      await this.store.delete(key).catch((cause: unknown) => {
        this.logger.warn({ err: cause }, 'orphaned staff upload could not be deleted');
      });
      throw error;
    }
  }

  /**
   * The references for the ids a person sends along with their text. Only files they uploaded
   * themselves can be attached (an id of someone else's file answers 400, as an id that does not exist
   * does), so an id seen in one note cannot be used to copy a file into another. Order is kept.
   */
  async claim(userId: string, ids: readonly string[] | undefined): Promise<StaffAttachment[]> {
    return (await this.rows(userId, ids)).map(toAttachment);
  }

  /** Same files as `claim`, in the shape of `message.attachments` so the ticket download route serves them. */
  async messageRecords(
    userId: string,
    ids: readonly string[] | undefined,
  ): Promise<Record<string, unknown>[]> {
    return (await this.rows(userId, ids)).map((row, index) => ({
      partId: `staff-${String(index + 1)}`,
      filename: row.filename,
      contentType: row.contentType,
      size: row.size,
      sha256: row.sha256,
      objectKey: row.objectKey,
      disposition: 'attachment',
      contentId: null,
      referencedByHtml: false,
    }));
  }

  /** The bytes of one stored file; 404 when there is no such file. */
  async read(id: string): Promise<StoredFile> {
    const [row] = await this.database.db
      .select()
      .from(schema.staffUpload)
      .where(eq(schema.staffUpload.id, id))
      .limit(1);
    if (row === undefined) throw notFound('No such file');
    let bytes: Uint8Array | null;
    try {
      bytes = await this.store.get(row.objectKey);
    } catch (error) {
      if (error instanceof ObjectStoreError) {
        throw new ApiHttpError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'storage_unavailable',
          'The file cannot be read right now; try again in a moment',
        );
      }
      throw error;
    }
    if (bytes === null) throw notFound('No such file');
    return { filename: row.filename, contentType: row.contentType, bytes };
  }

  private async rows(userId: string, ids: readonly string[] | undefined): Promise<UploadRow[]> {
    const wanted = [...new Set(ids ?? [])];
    if (wanted.length === 0) return [];
    if (wanted.length > STAFF_ATTACHMENTS_MAX) throw badRequest('Too many attachments');
    const found = await this.database.db
      .select()
      .from(schema.staffUpload)
      .where(
        and(inArray(schema.staffUpload.id, wanted), eq(schema.staffUpload.uploaderId, userId)),
      );
    const byId = new Map(found.map((row) => [row.id, row]));
    return wanted.map((id) => {
      const row = byId.get(id);
      if (row === undefined) throw badRequest('An attached file was not found; upload it again');
      return row;
    });
  }
}
