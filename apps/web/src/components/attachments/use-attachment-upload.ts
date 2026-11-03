'use client';

import {
  STAFF_ATTACHMENTS_MAX,
  STAFF_UPLOAD_MAX_BYTES,
  type StaffAttachment,
} from '@watchtower/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MessageKey } from '@/i18n';
import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';

import { isImageFile, uploadErrorKey, validateStaffFile, type AttachmentIssue } from './validate';

export type UploadStatus = 'uploading' | 'done' | 'error';

export interface UploadItem {
  readonly key: string;
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly status: UploadStatus;
  /** The reference to send as `attachmentIds`; set once `status` is `done`. */
  readonly attachment: StaffAttachment | null;
  /** Why it failed (`status === 'error'`). */
  readonly errorKey: MessageKey | null;
  /** A local object URL for an image, shown as the thumbnail before and after upload. */
  readonly previewUrl: string | null;
}

export interface AttachmentUpload {
  readonly items: readonly UploadItem[];
  /** Files turned away when they were added (type, size, count). */
  readonly issues: readonly AttachmentIssue[];
  /** Ids of the files that finished uploading, in the order they were added: send these with the text. */
  readonly attachmentIds: string[];
  /** True while any file is still uploading: disable the submit button. */
  readonly busy: boolean;
  /** True when some file failed and was neither retried nor removed. */
  readonly hasError: boolean;
  readonly max: number;
  /** What a screen reader hears after a file is removed. */
  readonly announcement: string;
  add: (files: readonly File[]) => void;
  remove: (key: string) => void;
  retry: (key: string) => void;
  /** Forget everything (after the text was saved). Does not delete anything on the server. */
  clear: () => void;
}

export interface UseAttachmentUploadOptions {
  /** Files per note; default `STAFF_ATTACHMENTS_MAX`. */
  max?: number;
  /** Files already saved with the thing being edited (a handoff draft): listed as done, sent again with the ids. */
  initial?: readonly StaffAttachment[];
}

/**
 * The files a person attaches to what they are writing. `add` checks each file and uploads it at once
 * (`POST /v1/uploads`), so by the time the text is saved the files are already stored and the save only
 * sends `attachmentIds`. Failed uploads stay in the list with a retry; removing a file only forgets it
 * (an unused upload is never linked to anything).
 */
export function useAttachmentUpload(options: UseAttachmentUploadOptions = {}): AttachmentUpload {
  const max = options.max ?? STAFF_ATTACHMENTS_MAX;
  const { t } = useI18n();
  const api = useApi();
  const [items, setItems] = useState<UploadItem[]>(() =>
    (options.initial ?? []).map((attachment) => ({
      key: `saved-${attachment.id}`,
      name: attachment.filename,
      size: attachment.size,
      type: attachment.contentType,
      status: 'done' as const,
      attachment,
      errorKey: null,
      previewUrl: null,
    })),
  );
  const [issues, setIssues] = useState<AttachmentIssue[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const files = useRef(new Map<string, File>());
  const controllers = useRef(new Map<string, AbortController>());
  const counter = useRef(0);
  const itemsRef = useRef<UploadItem[]>(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const patch = useCallback((key: string, change: Partial<UploadItem>) => {
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...change } : item)),
    );
  }, []);

  const start = useCallback(
    (key: string) => {
      const file = files.current.get(key);
      if (!file) return;
      const controller = new AbortController();
      controllers.current.set(key, controller);
      patch(key, { status: 'uploading', errorKey: null });
      api
        .uploadFile(file, controller.signal)
        .then((attachment) => {
          if (controller.signal.aborted) return;
          patch(key, { status: 'done', attachment, errorKey: null });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          patch(key, { status: 'error', errorKey: uploadErrorKey(error) });
        })
        .finally(() => {
          if (controllers.current.get(key) === controller) controllers.current.delete(key);
        });
    },
    [api, patch],
  );

  const release = useCallback((item: UploadItem) => {
    controllers.current.get(item.key)?.abort();
    controllers.current.delete(item.key);
    files.current.delete(item.key);
    if (item.previewUrl !== null) URL.revokeObjectURL(item.previewUrl);
  }, []);

  const add = useCallback(
    (incoming: readonly File[]) => {
      const accepted: UploadItem[] = [];
      const rejected: AttachmentIssue[] = [];
      let count = itemsRef.current.length;
      for (const file of incoming) {
        if (count >= max) {
          rejected.push({
            key: 'attachments.errors.tooMany',
            values: { name: file.name, count: max },
          });
          continue;
        }
        const issue = validateStaffFile(file);
        if (issue !== null) {
          rejected.push(issue);
          continue;
        }
        counter.current += 1;
        const key = `upload-${String(counter.current)}`;
        files.current.set(key, file);
        accepted.push({
          key,
          name: file.name,
          size: file.size,
          type: file.type,
          status: 'uploading',
          attachment: null,
          errorKey: null,
          previewUrl:
            isImageFile(file) && typeof URL.createObjectURL === 'function'
              ? URL.createObjectURL(file)
              : null,
        });
        count += 1;
      }
      setIssues(rejected);
      if (accepted.length === 0) return;
      setItems((current) => [...current, ...accepted]);
      for (const item of accepted) start(item.key);
    },
    [max, start],
  );

  const remove = useCallback(
    (key: string) => {
      const item = itemsRef.current.find((entry) => entry.key === key);
      if (!item) return;
      release(item);
      setItems((current) => current.filter((entry) => entry.key !== key));
      setIssues([]);
      setAnnouncement(t('attachments.removed', { name: item.name }));
    },
    [release, t],
  );

  const retry = useCallback(
    (key: string) => {
      setIssues([]);
      start(key);
    },
    [start],
  );

  const clear = useCallback(() => {
    for (const item of itemsRef.current) release(item);
    setItems([]);
    setIssues([]);
    setAnnouncement('');
  }, [release]);

  // Leaving the page: stop what is in flight and let go of the thumbnails.
  useEffect(() => {
    const liveControllers = controllers.current;
    return () => {
      for (const controller of liveControllers.values()) controller.abort();
      for (const item of itemsRef.current) {
        if (item.previewUrl !== null) URL.revokeObjectURL(item.previewUrl);
      }
    };
  }, []);

  return useMemo<AttachmentUpload>(
    () => ({
      items,
      issues,
      attachmentIds: items.flatMap((item) => (item.attachment ? [item.attachment.id] : [])),
      busy: items.some((item) => item.status === 'uploading'),
      hasError: items.some((item) => item.status === 'error'),
      max,
      announcement,
      add,
      remove,
      retry,
      clear,
    }),
    [items, issues, announcement, max, add, remove, retry, clear],
  );
}

export { STAFF_UPLOAD_MAX_BYTES };
