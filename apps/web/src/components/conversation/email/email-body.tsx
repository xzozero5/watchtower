'use client';

import type { Message } from '@watchtower/shared';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useApi } from '@/lib/api/api-context';

import { buildSrcDoc, sanitizeEmailHtml } from './html';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_INLINE_BYTES = 5 * 1024 * 1024;

function contentIdOf(file: Message['attachments'][number]): string | null {
  const raw = typeof file.contentId === 'string' ? file.contentId : '';
  const id = raw.replace(/^<|>$/g, '').trim().toLowerCase();
  return id === '' ? null : id;
}

/**
 * The inline images (`cid:`) of one message, fetched through the authenticated attachment download
 * and held as object URLs for as long as the message is on screen. Only raster images are used; an
 * SVG or any other type stays a placeholder.
 */
export function useCidImages(
  message: Message | undefined,
  wanted: readonly string[],
): Map<string, string> {
  const api = useApi();
  const [urls, setUrls] = useState<Map<string, string>>(() => new Map());
  const key = wanted.join('|');

  useEffect(() => {
    if (message === undefined || wanted.length === 0) return;
    const controller = new AbortController();
    const created: string[] = [];
    void (async () => {
      const next = new Map<string, string>();
      for (const [index, file] of message.attachments.entries()) {
        const id = contentIdOf(file);
        const type = typeof file.contentType === 'string' ? file.contentType.toLowerCase() : '';
        const size = typeof file.size === 'number' ? file.size : 0;
        if (id === null || !wanted.includes(id) || !IMAGE_TYPES.has(type)) continue;
        if (typeof file.objectKey !== 'string' || size > MAX_INLINE_BYTES) continue;
        try {
          const bytes = await api.downloadAttachment(
            message.ticketKey,
            message.id,
            index,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          const url = URL.createObjectURL(new Blob([bytes], { type }));
          created.push(url);
          next.set(id, url);
        } catch {
          // The image stays a placeholder; the text of the mail is still readable.
        }
      }
      if (!controller.signal.aborted) setUrls(next);
    })();
    return () => {
      controller.abort();
      for (const url of created) URL.revokeObjectURL(url);
    };
    // `key` stands for `wanted`; the message identity decides the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, message?.id, message?.ticketKey, key]);

  return urls;
}

/**
 * One email body, drawn in a sandboxed iframe: `srcdoc`, no scripts (the sandbox has no
 * `allow-scripts`, and a CSP says the same), no network except images the reader allowed. Its CSS
 * cannot reach the app and the app's cannot reach it. Same-origin is allowed only so the height can
 * be measured; nothing in the frame can run code.
 */
export function EmailBody({
  html,
  message,
  label,
  showImages = false,
  onBlockedImages,
  localImages,
}: {
  /** Sanitised HTML from the api (the api already dropped scripts and remote images). */
  html: string;
  /** The mail this body belongs to, for its inline images; none for a preview of an unsent mail. */
  message?: Message;
  label: string;
  showImages?: boolean;
  onBlockedImages?: (count: number) => void;
  /** Pictures that are not on the server yet (a preview of an unsent mail): content id to object URL. */
  localImages?: ReadonlyMap<string, string>;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);
  const wanted = useMemo(() => sanitizeEmailHtml(html).contentIds, [html]);
  const cids = useCidImages(message, wanted);

  const clean = useMemo(
    () =>
      sanitizeEmailHtml(html, {
        allowRemoteImages: showImages,
        resolveCid: (id) => cids.get(id) ?? localImages?.get(id) ?? null,
      }),
    [html, showImages, cids, localImages],
  );
  const srcDoc = useMemo(
    () => buildSrcDoc(clean.html, { allowRemoteImages: showImages }),
    [clean.html, showImages],
  );

  useEffect(() => {
    onBlockedImages?.(clean.blockedImages);
  }, [clean.blockedImages, onBlockedImages]);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let observer: ResizeObserver | undefined;
    const measure = () => {
      const doc = element.contentDocument;
      if (!doc) return;
      setHeight(Math.max(40, Math.ceil(doc.documentElement.scrollHeight)));
    };
    const onLoad = () => {
      measure();
      const body = element.contentDocument?.body;
      if (body && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(measure);
        observer.observe(body);
      }
    };
    element.addEventListener('load', onLoad);
    return () => {
      element.removeEventListener('load', onLoad);
      observer?.disconnect();
    };
  }, [srcDoc]);

  return (
    <iframe
      ref={frame}
      title={label}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      style={{ height }}
      className="block w-full rounded-md border-0"
    />
  );
}
