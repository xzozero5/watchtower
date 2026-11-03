import {
  STAFF_UPLOAD_MAX_BYTES,
  isImageContentType,
  portalAttachmentExtension,
} from '@watchtower/shared';

import type { MessageKey } from '@/i18n';
import { isApiError } from '@/lib/api/errors';

/** Why a file was not taken, as a message key plus its values (said in words, not only by colour). */
export interface AttachmentIssue {
  readonly key: MessageKey;
  readonly values: Record<string, string | number>;
}

const MB = 1024 * 1024;

/** The checks the page can make before sending; the api repeats them and also looks at the bytes. */
export function validateStaffFile(file: File): AttachmentIssue | null {
  const values = { name: file.name, size: STAFF_UPLOAD_MAX_BYTES / MB };
  if (file.size === 0) return { key: 'attachments.errors.empty', values };
  if (file.size > STAFF_UPLOAD_MAX_BYTES) return { key: 'attachments.errors.tooLarge', values };
  if (portalAttachmentExtension(file.name) === null) {
    return { key: 'attachments.errors.typeNotAllowed', values };
  }
  return null;
}

/** The message for a failed upload, from what the api answered. */
export function uploadErrorKey(error: unknown): MessageKey {
  if (isApiError(error)) {
    if (error.status === 413) return 'attachments.errors.tooLarge';
    if (error.status === 400) return 'attachments.errors.rejected';
    if (error.status === 429) return 'attachments.errors.rateLimited';
    if (error.status === 503) return 'attachments.errors.unavailable';
  }
  return 'attachments.errors.generic';
}

const PASTE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * A pasted screenshot arrives as a file called `image.png` (or with no useful name). Give it a name that
 * says what it is and when it was taken, so two pastes do not look the same in the list.
 */
export function nameClipboardFile(file: File, label: string, now: Date = new Date()): File {
  const extension = PASTE_EXTENSIONS[file.type.toLowerCase()];
  if (extension === undefined) return file;
  // A file copied from a folder has a real name; only the browser's generic `image.png` is replaced.
  if (file.name !== '' && !/^image\.[a-z0-9]+$/i.test(file.name)) return file;
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp =
    `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return new File([file], `${label}-${stamp}.${extension}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

/** Files on a clipboard or drag event: images are renamed (pasted), everything else keeps its name. */
export function filesFromTransfer(
  transfer: DataTransfer | null,
  label: string,
  rename: boolean,
): File[] {
  if (transfer === null) return [];
  const files = Array.from(transfer.files);
  return rename ? files.map((file) => nameClipboardFile(file, label)) : files;
}

export { isImageContentType };

export function isImageFile(file: { type: string; name: string }): boolean {
  return isImageContentType(file.type);
}
