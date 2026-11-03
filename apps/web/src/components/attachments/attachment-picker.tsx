'use client';

import { PORTAL_ATTACHMENT_ACCEPT, STAFF_UPLOAD_MAX_BYTES } from '@watchtower/shared';
import { Alert, Button, cn } from '@watchtower/ui';
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  LoaderCircle,
  Paperclip,
  RotateCw,
  X,
} from 'lucide-react';
import { useId, useRef, type ChangeEvent } from 'react';

import { useI18n } from '@/i18n/provider';
import { formatBytes } from '@/lib/portal/attachments';

import type { AttachmentUpload, UploadItem } from './use-attachment-upload';

/**
 * The "attach" control of a form: a button that opens the file chooser (a phone offers camera and
 * photo library), the files chosen so far as a list with a thumbnail, upload state, retry and remove
 * for each, and the reasons other files were turned away. Pair it with `<AttachmentDropZone>` around
 * the text field so paste and drop work too. All state lives in the `useAttachmentUpload` result.
 */
export function AttachmentPicker({
  upload,
  disabled = false,
  hideHint = false,
  className,
}: {
  upload: AttachmentUpload;
  disabled?: boolean;
  hideHint?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const uid = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const { items, issues, announcement } = upload;
  const hintId = `${uid}-hint`;
  const full = items.length >= upload.max;

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files ? Array.from(event.target.files) : [];
    // Clear the input so choosing the same file again (after removing it) still fires a change.
    event.target.value = '';
    if (picked.length > 0) upload.add(picked);
  };

  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="attachment-picker">
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept={PORTAL_ATTACHMENT_ACCEPT}
        aria-label={t('attachments.label')}
        aria-describedby={hideHint ? undefined : hintId}
        tabIndex={-1}
        onChange={onChange}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={addRef}
          type="button"
          size="sm"
          disabled={disabled || full}
          aria-describedby={hideHint ? undefined : hintId}
          onClick={() => {
            inputRef.current?.click();
          }}
        >
          <Paperclip aria-hidden className="size-4" />
          {items.length === 0 ? t('attachments.add') : t('attachments.addMore')}
        </Button>
        {hideHint ? null : (
          <p id={hintId} className="text-xs text-muted-foreground">
            {t('attachments.hint', {
              count: upload.max,
              size: STAFF_UPLOAD_MAX_BYTES / (1024 * 1024),
            })}
          </p>
        )}
      </div>

      {issues.length > 0 ? (
        <Alert tone="error" title={t('attachments.errors.title')}>
          <ul className="list-disc pl-5">
            {issues.map((issue, index) => (
              <li key={`${issue.key}-${String(index)}`}>{t(issue.key, issue.values)}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {items.length > 0 ? (
        <ul aria-label={t('attachments.listLabel')} className="flex flex-col gap-1.5">
          {items.map((item) => (
            <Row
              key={item.key}
              item={item}
              disabled={disabled}
              onRetry={() => {
                upload.retry(item.key);
              }}
              onRemove={() => {
                upload.remove(item.key);
                // The row with the pressed button disappears; keep focus on something real.
                setTimeout(() => addRef.current?.focus(), 0);
              }}
            />
          ))}
        </ul>
      ) : null}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

function Row({
  item,
  disabled,
  onRetry,
  onRemove,
}: {
  item: UploadItem;
  disabled: boolean;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  return (
    <li
      className={cn(
        'flex items-center gap-2 rounded-inner bg-surface-muted px-2 py-1.5 text-sm',
        item.status === 'error' && 'ring-1 ring-danger',
      )}
      data-status={item.status}
    >
      {item.previewUrl !== null ? (
        // A local object URL of the file the person just chose; not a remote image.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.previewUrl} alt="" className="size-10 shrink-0 rounded-inner object-cover" />
      ) : (
        <FileText aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block break-all">{item.name}</span>
        {item.status === 'error' && item.errorKey !== null ? (
          <span className="block text-xs text-danger" role="alert">
            {t(item.errorKey, { name: item.name, size: STAFF_UPLOAD_MAX_BYTES / (1024 * 1024) })}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {formatBytes(item.size)}
      </span>
      {item.status === 'uploading' ? (
        <span role="img" aria-label={t('attachments.uploading', { name: item.name })}>
          <LoaderCircle aria-hidden className="size-4 animate-spin text-muted-foreground" />
        </span>
      ) : item.status === 'done' ? (
        <span role="img" aria-label={t('attachments.uploaded')}>
          <CheckCircle2 aria-hidden className="size-4 text-success" />
        </span>
      ) : (
        <>
          <AlertCircle aria-hidden className="size-4 text-danger" />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            aria-label={t('attachments.retry', { name: item.name })}
            onClick={onRetry}
          >
            <RotateCw aria-hidden className="size-4" />
          </Button>
        </>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        aria-label={t('attachments.remove', { name: item.name })}
        onClick={onRemove}
      >
        <X aria-hidden className="size-4" />
      </Button>
    </li>
  );
}
