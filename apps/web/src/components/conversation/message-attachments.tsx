'use client';

import type { Message } from '@watchtower/shared';
import { Download, FileText, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { isApiError } from '@/lib/api/errors';
import { useSession } from '@/lib/auth/session';
import { formatBytes } from '@/lib/portal/attachments';

/** Metadata is displayed as text only. Storage keys never become links or DOM attributes. */
export function MessageAttachments({ message }: { message: Message }) {
  const { t } = useI18n();
  const { can } = useSession();
  // A masked reader cannot read the file's contents. The API independently enforces this too.
  if (!can('ticket.read') || message.attachments.length === 0) return null;
  return (
    <ul aria-label={t('timeline.attachments.label')} className="mt-2 flex flex-col gap-2">
      {message.attachments.map((file, index) => (
        <Attachment key={index} message={message} file={file} index={index} />
      ))}
    </ul>
  );
}

function Attachment({
  message,
  file,
  index,
}: {
  message: Message;
  file: Message['attachments'][number];
  index: number;
}) {
  const { t } = useI18n();
  const api = useApi();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<'failed' | 'forbidden' | 'missing' | null>(null);
  const active = useRef<AbortController | null>(null);
  const objectUrls = useRef(new Set<string>());
  const name =
    typeof file.filename === 'string' && file.filename.trim()
      ? file.filename
      : t('timeline.attachments.unnamed', { number: index + 1 });
  const available = typeof file.objectKey === 'string' && file.objectKey.length > 0;
  const size = typeof file.size === 'number' && Number.isFinite(file.size) && file.size >= 0;

  useEffect(() => {
    const urls = objectUrls.current;
    return () => {
      active.current?.abort();
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const download = async () => {
    if (active.current || !available) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setFailure(null);
    try {
      const bytes = await api.downloadAttachment(
        message.ticketKey,
        message.id,
        index,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      // The opaque blob is only ever downloaded, never rendered as a preview.
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      objectUrls.current.add(url);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // Let the browser consume the click before releasing its backing bytes.
      setTimeout(() => {
        if (objectUrls.current.delete(url)) URL.revokeObjectURL(url);
      }, 1000);
    } catch (error) {
      if (!controller.signal.aborted) {
        setFailure(
          isApiError(error) && error.status === 403
            ? 'forbidden'
            : isApiError(error) && error.status === 404
              ? 'missing'
              : 'failed',
        );
      }
    } finally {
      if (!controller.signal.aborted) setPending(false);
      if (active.current === controller) active.current = null;
    }
  };

  return (
    <li className="min-w-0 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 break-all">{name}</span>
        {size ? (
          <span className="shrink-0 text-muted-foreground">{formatBytes(file.size as number)}</span>
        ) : null}
        {available ? (
          <button
            type="button"
            aria-label={t(
              pending ? 'timeline.attachments.downloading' : 'timeline.attachments.download',
              { name },
            )}
            aria-busy={pending || undefined}
            disabled={pending}
            onClick={() => void download()}
            className="ml-auto inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded-sm text-link hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
          >
            {pending ? (
              <LoaderCircle aria-hidden className="size-4 motion-safe:animate-spin" />
            ) : (
              <Download aria-hidden className="size-4" />
            )}
          </button>
        ) : (
          <span className="text-muted-foreground">{t('timeline.attachments.unavailable')}</span>
        )}
      </div>
      {failure ? (
        <p role="alert" className="mt-1 text-danger">
          {t(`timeline.attachments.${failure}`)}
        </p>
      ) : null}
    </li>
  );
}
