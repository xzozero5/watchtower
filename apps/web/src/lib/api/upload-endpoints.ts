import { STAFF_UPLOAD_FIELD, staffAttachmentSchema } from '@watchtower/shared';

import type { ApiClient } from './client';

/** Staff uploads: one file per request, and the authenticated read-back used for thumbnails. */
export function createUploadEndpoints(client: ApiClient) {
  return {
    /** `POST /v1/uploads`: stores one file and answers a reference to send as `attachmentIds`. */
    uploadFile: (file: File, signal?: AbortSignal) => {
      const form = new FormData();
      form.append(STAFF_UPLOAD_FIELD, file, file.name);
      return client.request({
        method: 'POST',
        path: '/v1/uploads',
        body: form,
        schema: staffAttachmentSchema,
        ...(signal ? { signal } : {}),
      });
    },

    /** `GET /v1/uploads/{id}` as a blob (the session cookie authenticates it). */
    downloadUpload: (id: string, signal?: AbortSignal) =>
      client.download(`/v1/uploads/${encodeURIComponent(id)}`, signal),
  };
}
