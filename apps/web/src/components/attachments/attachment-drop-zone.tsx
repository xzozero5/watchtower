'use client';

import { cn } from '@watchtower/ui';
import { useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';

import { useI18n } from '@/i18n/provider';

import type { AttachmentUpload } from './use-attachment-upload';
import { filesFromTransfer } from './validate';

/**
 * Wraps the field people type in (a textarea, a rich box): pasting an image from the clipboard or
 * dropping files on it attaches them. Pasting plain text is left alone. A dashed ring and a short
 * line say where a drop will land while a file is dragged over.
 */
export function AttachmentDropZone({
  upload,
  children,
  disabled = false,
  className,
}: {
  upload: AttachmentUpload;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const [over, setOver] = useState(false);

  const hasFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes('Files');

  const onPaste = (event: ClipboardEvent) => {
    if (disabled) return;
    const files = filesFromTransfer(event.clipboardData, t('attachments.pastedName'), true);
    // A paste of text (even rich text that also carries a picture of it) keeps its default.
    if (files.length === 0) return;
    event.preventDefault();
    upload.add(files);
  };

  const onDrop = (event: DragEvent) => {
    setOver(false);
    if (disabled || !hasFiles(event)) return;
    event.preventDefault();
    upload.add(filesFromTransfer(event.dataTransfer, t('attachments.pastedName'), false));
  };

  return (
    <div
      className={cn(
        'relative rounded-inner',
        over && 'outline-2 outline-dashed outline-offset-2 outline-ring',
        className,
      )}
      data-testid="attachment-drop-zone"
      onPaste={onPaste}
      onDragOver={(event) => {
        if (disabled || !hasFiles(event)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={onDrop}
    >
      {children}
      {over ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-inner bg-surface/80 text-sm font-medium"
        >
          {t('attachments.dropHere')}
        </div>
      ) : null}
    </div>
  );
}
