'use client';

import { useQuery } from '@tanstack/react-query';
import {
  isImageContentType,
  staffAttachmentSchema,
  type StaffAttachment,
} from '@watchtower/shared';
import { Button, cn } from '@watchtower/ui';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  ImageOff,
  LoaderCircle,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { z } from 'zod';

import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { formatBytes } from '@/lib/portal/attachments';

/** Attachments read back from a jsonb payload (an incident timeline entry): keeps the valid ones. */
export function parseStaffAttachments(value: unknown): StaffAttachment[] {
  const parsed = z.array(z.unknown()).safeParse(value);
  if (!parsed.success) return [];
  return parsed.data.flatMap((entry) => {
    const one = staffAttachmentSchema.safeParse(entry);
    return one.success ? [one.data] : [];
  });
}

/** The file as a blob, fetched with the session (never a storage URL), kept for the life of the tab. */
function useUploadBlob(id: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['upload-blob', id],
    queryFn: ({ signal }) => api.downloadUpload(id, signal),
    enabled,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
  });
}

/** An object URL of a blob for as long as the component shows it. */
function useObjectUrl(blob: Blob | undefined, type: string): string | null {
  const url = useMemo(
    () =>
      blob !== undefined && typeof URL.createObjectURL === 'function'
        ? URL.createObjectURL(new Blob([blob], { type }))
        : null,
    [blob, type],
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
 * The files on a note, handoff, incident entry or message: images as thumbnails that open in a
 * lightbox (keyboard: Enter or Space opens, Esc closes, the arrow keys move between images, Tab stays
 * inside), other files as a name with a download button. Every byte is fetched through the
 * authenticated api and shown from a blob URL; the page never learns a storage address.
 */
export function AttachmentGallery({
  attachments,
  className,
}: {
  attachments: readonly StaffAttachment[];
  className?: string;
}) {
  const { t } = useI18n();
  const images = useMemo(
    () => attachments.filter((file) => isImageContentType(file.contentType)),
    [attachments],
  );
  const others = useMemo(
    () => attachments.filter((file) => !isImageContentType(file.contentType)),
    [attachments],
  );
  const [open, setOpen] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpen(null);
    // Back to the thumbnail that opened it.
    setTimeout(() => opener.current?.focus(), 0);
  }, []);

  if (attachments.length === 0) return null;
  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="attachment-gallery">
      {images.length > 0 ? (
        <ul aria-label={t('attachments.gallery.label')} className="flex flex-wrap gap-2">
          {images.map((file, index) => (
            <li key={file.id}>
              <Thumbnail
                file={file}
                onOpen={(element) => {
                  opener.current = element;
                  setOpen(index);
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {others.length > 0 ? (
        <ul
          aria-label={images.length > 0 ? undefined : t('attachments.gallery.label')}
          className="flex flex-col gap-1"
        >
          {others.map((file) => (
            <li key={file.id}>
              <FileRow file={file} />
            </li>
          ))}
        </ul>
      ) : null}
      {open !== null ? (
        <Lightbox images={images} index={open} onIndex={setOpen} onClose={close} />
      ) : null}
    </div>
  );
}

function Thumbnail({
  file,
  onOpen,
}: {
  file: StaffAttachment;
  onOpen: (element: HTMLElement) => void;
}) {
  const { t } = useI18n();
  const blob = useUploadBlob(file.id);
  const url = useObjectUrl(blob.data, file.contentType);
  return (
    <button
      type="button"
      aria-label={t('attachments.gallery.open', { name: file.filename })}
      onClick={(event) => {
        onOpen(event.currentTarget);
      }}
      className="flex size-24 items-center justify-center overflow-hidden rounded-inner border border-border bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {url !== null ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={file.filename} className="size-full object-cover" />
      ) : blob.isError ? (
        <span role="img" aria-label={t('attachments.gallery.loadFailed', { name: file.filename })}>
          <ImageOff aria-hidden className="size-6 text-muted-foreground" />
        </span>
      ) : (
        <span role="img" aria-label={t('attachments.gallery.loading', { name: file.filename })}>
          <LoaderCircle aria-hidden className="size-5 animate-spin text-muted-foreground" />
        </span>
      )}
    </button>
  );
}

function FileRow({ file }: { file: StaffAttachment }) {
  const { t } = useI18n();
  const api = useApi();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const download = async () => {
    setPending(true);
    setFailed(false);
    try {
      const blob = await api.downloadUpload(file.id);
      // Only ever downloaded, never rendered in the page.
      const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 break-all">{file.filename}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {formatBytes(file.size)}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={pending}
        aria-busy={pending || undefined}
        aria-label={t('attachments.gallery.download', { name: file.filename })}
        onClick={() => void download()}
      >
        <Download aria-hidden className="size-4" />
      </Button>
      {failed ? (
        <span role="alert" className="text-xs text-danger">
          {t('attachments.gallery.loadFailed', { name: file.filename })}
        </span>
      ) : null}
    </div>
  );
}

function Lightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: readonly StaffAttachment[];
  index: number;
  onIndex: (next: number) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const file = images[index];
  const blob = useUploadBlob(file?.id ?? '', file !== undefined);
  const url = useObjectUrl(blob.data, file?.contentType ?? 'application/octet-stream');
  const closeRef = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  if (file === undefined) return null;
  const many = images.length > 1;
  const go = (step: number) => {
    onIndex((index + step + images.length) % images.length);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    } else if (event.key === 'ArrowLeft' && many) {
      go(-1);
    } else if (event.key === 'ArrowRight' && many) {
      go(1);
    } else if (event.key === 'Tab') {
      // Keep Tab inside the dialog.
      const controls = Array.from(root.current?.querySelectorAll<HTMLElement>('button') ?? []);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (first && last) {
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
  };

  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={`${t('attachments.gallery.dialog')}: ${file.filename}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 flex flex-col bg-foreground/80 p-4"
    >
      <div className="flex items-center gap-2 text-sm text-background">
        <span className="min-w-0 flex-1 break-all">{file.filename}</span>
        {many ? (
          <span aria-live="polite" className="tabular-nums">
            {t('attachments.gallery.counter', { index: index + 1, total: images.length })}
          </span>
        ) : null}
        <Button
          ref={closeRef}
          type="button"
          size="icon"
          aria-label={t('attachments.gallery.close')}
          onClick={onClose}
        >
          <X aria-hidden className="size-4" />
        </Button>
      </div>
      {/* The backdrop closes on click; the image area is the only part that does not. */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        {many ? (
          <Button
            type="button"
            size="icon"
            aria-label={t('attachments.gallery.previous')}
            onClick={() => {
              go(-1);
            }}
            className="absolute left-0"
          >
            <ChevronLeft aria-hidden className="size-5" />
          </Button>
        ) : null}
        {url !== null ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={file.filename}
            className="max-h-full max-w-full rounded-inner object-contain"
          />
        ) : blob.isError ? (
          <div role="alert" className="flex flex-col items-center gap-2 text-background">
            <ImageOff aria-hidden className="size-8" />
            {t('attachments.gallery.loadFailed', { name: file.filename })}
            <Button
              type="button"
              onClick={() => {
                void blob.refetch();
              }}
            >
              {t('attachments.gallery.retry')}
            </Button>
          </div>
        ) : (
          <span role="img" aria-label={t('attachments.gallery.loading', { name: file.filename })}>
            <LoaderCircle aria-hidden className="size-8 animate-spin text-background" />
          </span>
        )}
        {many ? (
          <Button
            type="button"
            size="icon"
            aria-label={t('attachments.gallery.next')}
            onClick={() => {
              go(1);
            }}
            className="absolute right-0"
          >
            <ChevronRight aria-hidden className="size-5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
