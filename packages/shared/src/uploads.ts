import { z } from 'zod';

// --- staff uploads (images and files attached to tickets, notes, handoffs, incident notes) ---

/** One file per request; the page uploads several in parallel and shows progress per file. `[ASSUMED]` limits. */
export const STAFF_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** Files that may hang on one note, handoff or timeline entry. */
export const STAFF_ATTACHMENTS_MAX = 10;
/** Multipart field of `POST /v1/uploads`. */
export const STAFF_UPLOAD_FIELD = 'file';
/** Uploads one person may make in an hour `[ASSUMED]`: a human pace with room for a burst of screenshots. */
export const STAFF_UPLOAD_LIMITS = { perUserPerHour: 300 } as const;

export const IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** True for the content types the browser can show as a thumbnail. */
export function isImageContentType(contentType: string): boolean {
  return (IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType.toLowerCase());
}

/**
 * What a note, handoff or timeline entry carries for a file: a reference, never a storage URL. The
 * file is read back through `GET /v1/uploads/{id}` by a signed-in person.
 */
export const staffAttachmentSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().min(0),
});
export type StaffAttachment = z.infer<typeof staffAttachmentSchema>;

/** Ids returned by `POST /v1/uploads`, sent along with the text they belong to. */
export const attachmentIdsSchema = z.array(z.uuid()).max(STAFF_ATTACHMENTS_MAX);

export const uploadIdParamSchema = z.object({ id: z.uuid() });
export type UploadIdParam = z.infer<typeof uploadIdParamSchema>;

export const uploadedFileSchema = staffAttachmentSchema;
