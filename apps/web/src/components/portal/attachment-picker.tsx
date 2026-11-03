'use client';

import {
  PORTAL_ATTACHMENT_ACCEPT,
  PORTAL_ATTACHMENT_MAX_BYTES,
  PORTAL_ATTACHMENT_MAX_FILES,
} from '@watchtower/shared';
import { Alert, Button } from '@watchtower/ui';
import { FileText, Paperclip, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
} from 'react';

import { filesFromTransfer, isImageFile } from '@/components/attachments/validate';
import { useI18n } from '@/i18n/provider';
import {
  addAttachments,
  formatBytes,
  removeAttachment,
  type AttachmentIssue,
} from '@/lib/portal/attachments';

export interface AttachmentState {
  files: File[];
  issues: AttachmentIssue[];
  /** What a screen reader hears after a file is removed. */
  announcement: string;
  add: (incoming: readonly File[]) => void;
  remove: (index: number, name: string) => void;
  clear: () => void;
}

/** The files picked so far and the reasons other files were turned away. */
export function useAttachments(): AttachmentState {
  const { t } = useI18n();
  const [state, setState] = useState<{
    files: File[];
    issues: AttachmentIssue[];
    announcement: string;
  }>({ files: [], issues: [], announcement: '' });

  const add = useCallback((incoming: readonly File[]) => {
    setState((current) => {
      const result = addAttachments(current.files, incoming);
      return { files: result.files, issues: result.issues, announcement: '' };
    });
  }, []);
  const remove = useCallback(
    (index: number, name: string) => {
      setState((current) => ({
        files: removeAttachment(current.files, index),
        issues: [],
        announcement: t('portal.attachments.removed', { name }),
      }));
    },
    [t],
  );
  const clear = useCallback(() => {
    setState({ files: [], issues: [], announcement: '' });
  }, []);

  return { ...state, add, remove, clear };
}

/** A local thumbnail of a chosen image, released when the row goes away. */
function useFilePreview(file: File): string | null {
  const url = useMemo(
    () =>
      isImageFile(file) && typeof URL.createObjectURL === 'function'
        ? URL.createObjectURL(file)
        : null,
    [file],
  );
  useEffect(
    () => () => {
      if (url !== null) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}

/**
 * Wraps the description or reply box so a customer can paste a screenshot or drop files on it. Text
 * pastes are untouched. The same checks as the file button apply (type, size, count).
 */
export function PortalPasteZone({
  state,
  disabled = false,
  children,
}: {
  state: AttachmentState;
  disabled?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const hasFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes('Files');
  return (
    // A column, like the form field around it, so the text box inside still stretches to full width.
    <div
      className="flex flex-col"
      onPaste={(event: ClipboardEvent) => {
        if (disabled) return;
        const files = filesFromTransfer(event.clipboardData, t('attachments.pastedName'), true);
        if (files.length === 0) return;
        event.preventDefault();
        state.add(files);
      }}
      onDragOver={(event) => {
        if (!disabled && hasFiles(event)) event.preventDefault();
      }}
      onDrop={(event) => {
        if (disabled || !hasFiles(event)) return;
        event.preventDefault();
        state.add(filesFromTransfer(event.dataTransfer, t('attachments.pastedName'), false));
      }}
    >
      {children}
    </div>
  );
}

function FileRow({
  file,
  disabled,
  onRemove,
}: {
  file: File;
  disabled: boolean;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const preview = useFilePreview(file);
  return (
    <li className="flex items-center gap-2 rounded-inner bg-surface-muted px-3 py-1.5 text-sm">
      {preview !== null ? (
        // A local object URL of the file the customer just chose; not a remote image.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt="" className="size-10 shrink-0 rounded-inner object-cover" />
      ) : (
        <FileText aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 break-all">{file.name}</span>
      <span className="shrink-0 text-muted-foreground tabular-nums">{formatBytes(file.size)}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        aria-label={t('portal.attachments.remove', { name: file.name })}
        onClick={onRemove}
      >
        <X aria-hidden className="size-4" />
      </Button>
    </li>
  );
}

/**
 * File input for the submit form and the reply box (R-9.1, R-9.3). The native input is hidden and
 * a real button opens it, so the control is reachable by keyboard and works the same on a phone
 * (which offers camera and photo library). Files are checked as they are added (type, size, count);
 * the api checks again and looks at the content. The chosen files are listed with a remove button
 * each, and what was turned away is said in words, not just by colour.
 */
export function AttachmentPicker({
  state,
  disabled = false,
}: {
  state: AttachmentState;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const uid = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const { files, issues, announcement, add, remove } = state;
  const hintId = `${uid}-hint`;

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files ? Array.from(event.target.files) : [];
    // Clear the input so choosing the same file again (after removing it) still fires a change.
    event.target.value = '';
    if (picked.length > 0) add(picked);
  };

  const full = files.length >= PORTAL_ATTACHMENT_MAX_FILES;

  return (
    <div className="flex flex-col gap-2" data-testid="portal-attachments">
      <span id={`${uid}-label`} className="text-sm font-medium">
        {t('portal.attachments.label')}{' '}
        <span className="font-normal text-muted-foreground">({t('portal.optional')})</span>
      </span>
      <p id={hintId} className="text-sm text-muted-foreground">
        {t('portal.attachments.hint', {
          count: PORTAL_ATTACHMENT_MAX_FILES,
          size: PORTAL_ATTACHMENT_MAX_BYTES / (1024 * 1024),
        })}
      </p>

      <input
        ref={inputRef}
        id={`${uid}-input`}
        type="file"
        multiple
        hidden
        accept={PORTAL_ATTACHMENT_ACCEPT}
        aria-labelledby={`${uid}-label`}
        aria-describedby={hintId}
        tabIndex={-1}
        onChange={onChange}
      />
      <div>
        <Button
          ref={addRef}
          type="button"
          disabled={disabled || full}
          aria-describedby={hintId}
          onClick={() => {
            inputRef.current?.click();
          }}
          className="w-full sm:w-auto"
        >
          <Paperclip aria-hidden className="size-4" />
          {files.length === 0 ? t('portal.attachments.add') : t('portal.attachments.addMore')}
        </Button>
      </div>

      {issues.length > 0 ? (
        <Alert tone="error" title={t('portal.attachments.errorsTitle')}>
          <ul className="list-disc pl-5">
            {issues.map((issue, index) => (
              <li key={`${issue.key}-${String(index)}`}>{t(issue.key, issue.values)}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {files.length > 0 ? (
        <ul aria-label={t('portal.attachments.listLabel')} className="flex flex-col gap-1.5">
          {files.map((file, index) => (
            <FileRow
              key={`${file.name}-${String(file.size)}-${String(file.lastModified)}`}
              file={file}
              disabled={disabled}
              onRemove={() => {
                remove(index, file.name);
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
