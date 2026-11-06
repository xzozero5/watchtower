'use client';

import type { EmailAddress, TimelineEntry } from '@watchtower/shared';
import { Button, cn } from '@watchtower/ui';
import { Eye, Pencil, PenLine, Users, X } from 'lucide-react';
import { type KeyboardEvent, type Ref, useEffect, useMemo, useState } from 'react';

import { useI18n } from '@/i18n/provider';
import { formatDateTime } from '@/lib/format';

import { EmailBody } from './email-body';
import { escapeHtml, htmlToText, textToHtml } from './html';
import { RecipientField } from './recipient-field';
import { addRecipients } from './recipients';
import { RichEditor, type ImageFilesHandler, type RichEditorHandle } from './rich-editor';
import { splitQuotedText } from './quoted';
import { replyDefaults } from './thread';

/** What the composer reports upward: the finished email and whether it can be sent. */
export interface EmailDraft {
  readonly text: string;
  readonly html: string;
  /** What the person typed, without signature and quote: empty means nothing was written. */
  readonly written: boolean;
  readonly to: EmailAddress[];
  readonly cc: EmailAddress[];
  readonly bcc: EmailAddress[];
  readonly subject: string;
  /** Uploaded pictures the HTML shows with `cid:`: sent inline, not as files. */
  readonly inline: { attachmentId: string; contentId: string }[];
}

const editorHtmlByTicket = new Map<string, string>();

/** The editor's HTML per ticket while the tab is open, like `draftStore` is for text. */
export const emailDraftStore = {
  get: (ticketKey: string) => editorHtmlByTicket.get(ticketKey) ?? '',
  set(ticketKey: string, html: string) {
    if (html === '') editorHtmlByTicket.delete(ticketKey);
    else editorHtmlByTicket.set(ticketKey, html);
  },
  clear: () => {
    editorHtmlByTicket.clear();
  },
};

const NONE: EmailAddress[] = [];
const SIGNATURE_KEY = 'wt.email.signature';

function readSignature(fallback: string): string {
  try {
    return window.localStorage.getItem(SIGNATURE_KEY) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveSignature(text: string): void {
  try {
    window.localStorage.setItem(SIGNATURE_KEY, text);
  } catch {
    // Private mode: the signature lasts for this visit only.
  }
}

const LOCAL_DOMAIN = 'wt.local';

/**
 * Pictures inserted from uploads carry the object URL they are shown with while editing. For the
 * mail they become `cid:<uploadId>@wt.local` and are listed in `inline`, so the server sends them
 * as inline parts of a multipart/related body.
 */
export function inlineToCid(html: string): {
  html: string;
  inline: { attachmentId: string; contentId: string }[];
} {
  if (!html.includes('data-wt-upload')) return { html, inline: [] };
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, 'text/html');
  const inline: { attachmentId: string; contentId: string }[] = [];
  for (const image of Array.from(doc.querySelectorAll('img[data-wt-upload]'))) {
    const id = image.getAttribute('data-wt-upload') ?? '';
    image.removeAttribute('data-wt-upload');
    image.removeAttribute('style');
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      image.remove();
      continue;
    }
    const contentId = `${id}@${LOCAL_DOMAIN}`;
    image.setAttribute('src', `cid:${contentId}`);
    if (!inline.some((entry) => entry.attachmentId === id)) {
      inline.push({ attachmentId: id, contentId });
    }
  }
  return { html: doc.getElementById('r')?.innerHTML ?? html, inline };
}

/** The finished mail: what was written, the signature, and the quoted message. Pure, so it is tested alone. */
export function composeEmail(parts: {
  editorHtml: string;
  signature: string;
  quote: { header: string; text: string } | null;
}): { html: string; text: string; written: boolean } {
  const written = htmlToText(parts.editorHtml) !== '';
  const signature = parts.signature.trim();
  const html = [
    parts.editorHtml,
    signature === '' ? '' : `<div>--<br>${escapeHtml(signature).replace(/\n/g, '<br>')}</div>`,
    parts.quote
      ? `<div><div>${escapeHtml(parts.quote.header)}</div><blockquote>${textToHtml(parts.quote.text)}</blockquote></div>`
      : '',
  ].join('');
  return { html, text: htmlToText(html), written };
}

/**
 * The email tool for a reply on an email ticket: To / Cc / Bcc, subject, a rich-text body, the
 * signature, the message being answered (collapsed behind a button), and a preview that draws the
 * mail the way the customer's mail program will. It reports the finished email upward; the composer
 * around it keeps the send button, the status menu and the error line.
 */
export function EmailComposer({
  ticketKey,
  ticketSubject,
  requesterAddress,
  requesterName,
  entries,
  self,
  senderName,
  label,
  placeholder,
  editorRef,
  onChange,
  onKeyDown,
  onImageFiles,
  localImages,
  describedBy,
}: {
  ticketKey: string;
  ticketSubject: string;
  requesterAddress: string | null;
  requesterName: string | null;
  entries: readonly TimelineEntry[];
  /** The writer's own address: left out of "Reply all". */
  self: string | null;
  senderName: string;
  label: string;
  placeholder: string;
  editorRef: Ref<RichEditorHandle>;
  onChange: (draft: EmailDraft) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** Called with pasted, dropped or picked images. Unset until the upload component is wired in. */
  onImageFiles?: ImageFilesHandler;
  /** Upload id to the object URL its picture is shown with while editing (for the preview). */
  localImages?: ReadonlyMap<string, string>;
  describedBy?: string;
}) {
  const { t, locale } = useI18n();
  const defaults = useMemo(
    () =>
      replyDefaults(entries, {
        requester: requesterAddress
          ? { address: requesterAddress, ...(requesterName ? { name: requesterName } : {}) }
          : null,
        self,
        ticketSubject,
      }),
    [entries, requesterAddress, requesterName, self, ticketSubject],
  );

  const [edits, setEdits] = useState<{
    to?: EmailAddress[];
    cc?: EmailAddress[];
    bcc?: EmailAddress[];
    subject?: string;
  }>({});
  const to = edits.to ?? defaults.to;
  const cc = edits.cc ?? NONE;
  const bcc = edits.bcc ?? NONE;
  const subject = edits.subject ?? defaults.subject;
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [editorHtml, setEditorHtml] = useState(() => emailDraftStore.get(ticketKey));
  const [signature, setSignature] = useState(() => readSignature(senderName));
  const [editingSignature, setEditingSignature] = useState(false);
  const [quoteIncluded, setQuoteIncluded] = useState(true);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [preview, setPreview] = useState(false);

  const quoted = defaults.quoted;
  const quote = useMemo(() => {
    if (!quoted || !quoteIncluded) return null;
    const who = quoted.emailMeta?.from?.name?.trim() || quoted.sender.name || '';
    const address = quoted.emailMeta?.from?.address;
    return {
      header: t('email.compose.quotedWrote', {
        date: formatDateTime(quoted.createdAt, locale),
        name: address ? `${who} <${address}>`.trim() : who,
      }),
      text: splitQuotedText(quoted.bodyText).visible,
    };
  }, [quoted, quoteIncluded, t, locale]);

  const composed = useMemo(
    () => composeEmail({ editorHtml, signature, quote }),
    [editorHtml, signature, quote],
  );

  const finished = useMemo(() => inlineToCid(composed.html), [composed.html]);
  const previewImages = useMemo(() => {
    const map = new Map<string, string>();
    for (const [id, url] of localImages ?? []) map.set(`${id.toLowerCase()}@${LOCAL_DOMAIN}`, url);
    return map;
  }, [localImages]);

  useEffect(() => {
    onChange({
      text: composed.written ? composed.text : '',
      html: finished.html,
      inline: finished.inline,
      written: composed.written,
      to,
      cc,
      bcc,
      subject,
    });
    // `to`, `cc` and `bcc` are new arrays only when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composed, finished, to, cc, bcc, subject]);

  const replyAll = () => {
    setEdits((current) => ({ ...current, cc: addRecipients(current.cc ?? [], defaults.others) }));
    setShowCc(true);
  };

  const ccVisible = showCc || cc.length > 0;
  const bccVisible = showBcc || bcc.length > 0;
  const linkButton =
    'rounded-sm px-1 text-xs text-link hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring';

  return (
    <div data-testid="email-composer" className="flex flex-col">
      <div className="flex flex-col divide-y divide-border/60">
        <div className="flex items-start">
          <div className="min-w-0 flex-1">
            <RecipientField
              label={t('email.compose.to')}
              value={to}
              required
              onChange={(next) => {
                setEdits((current) => ({ ...current, to: next }));
              }}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1 px-2 pt-1.5">
            {defaults.others.length > 0 ? (
              <button
                type="button"
                onClick={replyAll}
                className={cn(linkButton, 'inline-flex items-center gap-1')}
              >
                <Users aria-hidden className="size-3.5" />
                {t('email.compose.replyAll')}
              </button>
            ) : null}
            {!ccVisible ? (
              <button
                type="button"
                onClick={() => {
                  setShowCc(true);
                }}
                className={linkButton}
              >
                {t('email.compose.addCc')}
              </button>
            ) : null}
            {!bccVisible ? (
              <button
                type="button"
                onClick={() => {
                  setShowBcc(true);
                }}
                className={linkButton}
              >
                {t('email.compose.addBcc')}
              </button>
            ) : null}
          </div>
        </div>
        {ccVisible ? (
          <div className="flex items-start">
            <div className="min-w-0 flex-1">
              <RecipientField
                label={t('email.compose.cc')}
                value={cc}
                onChange={(next) => {
                  setEdits((current) => ({ ...current, cc: next }));
                }}
              />
            </div>
            <RemoveRowButton
              label={t('email.compose.removeCc')}
              onClick={() => {
                setEdits((current) => ({ ...current, cc: [] }));
                setShowCc(false);
              }}
            />
          </div>
        ) : null}
        {bccVisible ? (
          <div className="flex items-start">
            <div className="min-w-0 flex-1">
              <RecipientField
                label={t('email.compose.bcc')}
                value={bcc}
                onChange={(next) => {
                  setEdits((current) => ({ ...current, bcc: next }));
                }}
              />
            </div>
            <RemoveRowButton
              label={t('email.compose.removeBcc')}
              onClick={() => {
                setEdits((current) => ({ ...current, bcc: [] }));
                setShowBcc(false);
              }}
            />
          </div>
        ) : null}
        <div className="flex items-center gap-2 px-3 py-1 text-sm">
          <label
            htmlFor={`${ticketKey}-subject`}
            className="w-12 shrink-0 text-xs text-muted-foreground"
          >
            {t('email.compose.subject')}
          </label>
          <input
            id={`${ticketKey}-subject`}
            value={subject}
            maxLength={998}
            onChange={(event) => {
              setEdits((current) => ({ ...current, subject: event.target.value }));
            }}
            className="min-w-0 flex-1 bg-transparent py-0.5 text-sm font-medium outline-hidden"
          />
          <Button
            type="button"
            variant="ghost"
            className="h-6 gap-1 rounded-full px-2 text-xs text-muted-foreground"
            aria-pressed={preview}
            onClick={() => {
              setPreview((on) => !on);
            }}
          >
            {preview ? (
              <Pencil aria-hidden className="size-3.5" />
            ) : (
              <Eye aria-hidden className="size-3.5" />
            )}
            {preview ? t('email.compose.edit') : t('email.compose.preview')}
          </Button>
        </div>
      </div>

      {preview ? (
        <section
          aria-label={t('email.compose.previewTitle')}
          className="m-2 rounded-md border border-border bg-surface"
        >
          <header className="border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">{subject}</p>
            <p>
              {t('email.compose.previewFrom')}: {senderName}
            </p>
            <p>
              {t('email.compose.to')}: {to.map((entry) => entry.address).join(', ')}
            </p>
            {cc.length > 0 ? (
              <p>
                {t('email.compose.cc')}: {cc.map((entry) => entry.address).join(', ')}
              </p>
            ) : null}
          </header>
          {composed.written ? (
            <EmailBody
              html={finished.html}
              label={t('email.compose.previewTitle')}
              localImages={previewImages}
            />
          ) : (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              {t('email.compose.previewEmpty')}
            </p>
          )}
          <p className="border-t border-border/60 px-3 py-1 text-xs text-muted-foreground">
            {t('email.compose.sendsAs')}
          </p>
        </section>
      ) : (
        <>
          <RichEditor
            label={label}
            placeholder={placeholder}
            initialHtml={editorHtml}
            handleRef={editorRef}
            describedBy={describedBy}
            onChange={(html) => {
              setEditorHtml(html);
              emailDraftStore.set(ticketKey, html);
            }}
            {...(onKeyDown ? { onKeyDown } : {})}
            {...(onImageFiles ? { onImageFiles } : {})}
          />

          <div className="flex flex-col gap-1 px-3 pb-2 text-xs text-muted-foreground">
            {editingSignature ? (
              <div className="flex items-end gap-2">
                <textarea
                  aria-label={t('email.compose.signatureField')}
                  value={signature}
                  rows={3}
                  placeholder={t('email.compose.signaturePlaceholder')}
                  onChange={(event) => {
                    setSignature(event.target.value);
                    saveSignature(event.target.value);
                  }}
                  className="min-w-0 flex-1 resize-none rounded-md bg-surface px-2 py-1 text-sm text-foreground ring-1 ring-border outline-hidden ring-inset"
                />
                <button
                  type="button"
                  onClick={() => {
                    setEditingSignature(false);
                  }}
                  className={linkButton}
                >
                  {t('email.compose.signatureDone')}
                </button>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 break-words whitespace-pre-wrap">
                  {signature.trim() === '' ? '' : `--\n${signature}`}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setEditingSignature(true);
                  }}
                  className={cn(linkButton, 'inline-flex shrink-0 items-center gap-1')}
                >
                  <PenLine aria-hidden className="size-3.5" />
                  {t('email.compose.editSignature')}
                </button>
              </div>
            )}

            {quoted && quoteIncluded ? (
              <div>
                <button
                  type="button"
                  aria-expanded={quoteOpen}
                  title={quoteOpen ? t('email.compose.quotedHide') : t('email.compose.quoted')}
                  onClick={() => {
                    setQuoteOpen((open) => !open);
                  }}
                  className="inline-flex h-5 items-center rounded-full bg-surface px-2 font-medium ring-1 ring-border ring-inset hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <span aria-hidden>···</span>
                  <span className="sr-only">
                    {quoteOpen ? t('email.compose.quotedHide') : t('email.compose.quoted')}
                  </span>
                </button>
                {quoteOpen && quote ? (
                  <div className="mt-1">
                    <p>{quote.header}</p>
                    <blockquote className="ml-1 border-l-2 border-border-strong pl-3 whitespace-pre-wrap">
                      {quote.text}
                    </blockquote>
                    <button
                      type="button"
                      onClick={() => {
                        setQuoteIncluded(false);
                      }}
                      className={cn(linkButton, 'mt-1')}
                    >
                      {t('email.compose.removeQuoted')}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

/** The X at the end of the Cc or Bcc row: takes the row away with the addresses in it. */
function RemoveRowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="mt-1.5 mr-2 grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-surface-muted hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring"
    >
      <X aria-hidden className="size-3.5" />
    </button>
  );
}
