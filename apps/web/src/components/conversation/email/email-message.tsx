'use client';

import type { Message } from '@watchtower/shared';
import { Avatar, cn, Tooltip } from '@watchtower/ui';
import { ChevronDown, ChevronRight, ImageOff, Paperclip } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';

import { useI18n } from '@/i18n/provider';
import { formatDateTime } from '@/lib/format';

import { MessageAttachments } from '../message-attachments';
import { EmailBody } from './email-body';
import { splitQuotedHtml, splitQuotedText } from './quoted';
import { formatAddress, senderParty, snippetOf } from './thread';

const LINK =
  'inline-flex items-center gap-1 rounded-sm text-xs text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function Details({ message }: { message: Message }) {
  const { t, locale } = useI18n();
  const meta = message.emailMeta;
  const sender = senderParty(message);
  const rows: [string, string][] = [
    [
      t('email.message.from'),
      sender.address
        ? formatAddress({ address: sender.address, name: sender.name })
        : (sender.name ?? t('email.message.unknownSender')),
    ],
  ];
  if (meta?.to.length) rows.push([t('email.message.to'), meta.to.map(formatAddress).join(', ')]);
  if (meta?.cc.length) rows.push([t('email.message.cc'), meta.cc.map(formatAddress).join(', ')]);
  if (meta?.bcc.length) rows.push([t('email.message.bcc'), meta.bcc.map(formatAddress).join(', ')]);
  rows.push([t('email.message.date'), formatDateTime(message.createdAt, locale)]);
  if (meta?.subject) rows.push([t('email.message.subject'), meta.subject]);
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md bg-surface-muted px-3 py-2 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One email in a thread, drawn like Gmail: a one-line row when collapsed (who, the first words,
 * when), and when open a header (name and address, "to ...", date, details), the body as the sender
 * wrote it, the quoted history behind "Show trimmed content", and the files.
 */
export function EmailMessageCard({
  message,
  kind,
  expanded,
  onToggle,
  actions,
  footer,
}: {
  message: Message;
  kind: 'reply' | 'customer';
  expanded: boolean;
  onToggle: () => void;
  /** Copy / Quote buttons of the timeline. */
  actions?: ReactNode;
  /** Delivery state (Undo, failed) of an outbound mail. */
  footer?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const [details, setDetails] = useState(false);
  const [showTrimmed, setShowTrimmed] = useState(false);
  const [showImages, setShowImages] = useState(false);
  const [blocked, setBlocked] = useState(0);
  const onBlocked = useCallback((count: number) => {
    setBlocked(count);
  }, []);

  const sender = senderParty(message);
  const name = sender.name ?? sender.address ?? t('email.message.unknownSender');
  const exact = formatDateTime(message.createdAt, locale);
  const html = message.bodyHtml ?? null;

  const split = useMemo(
    () => (html !== null && html.trim() !== '' ? splitQuotedHtml(html) : null),
    [html],
  );
  const textSplit = useMemo(() => splitQuotedText(message.bodyText), [message.bodyText]);
  const quoted = split ? split.quoted : textSplit.quoted;
  const snippet = snippetOf(textSplit.visible || message.bodyText);
  const hasFiles = message.attachments.length > 0;

  const recipients = message.emailMeta?.to ?? [];
  const toLine =
    recipients.length > 0
      ? t('email.message.toOthers', {
          names: recipients
            .slice(0, 2)
            .map((entry) => entry.name?.trim() || entry.address)
            .join(', ')
            .concat(recipients.length > 2 ? ` +${String(recipients.length - 2)}` : ''),
        })
      : t('email.message.toMe');

  const shell = cn(
    'w-full min-w-0 rounded-lg border bg-surface',
    kind === 'reply' ? 'border-primary/30' : 'border-border',
  );

  if (!expanded) {
    return (
      <article
        data-message-kind={kind}
        data-email="collapsed"
        aria-label={t(`timeline.kinds.${kind}`)}
        className={shell}
      >
        <button
          type="button"
          aria-expanded={false}
          aria-label={t('email.message.expand', { name })}
          onClick={onToggle}
          className="flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
        >
          <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <Avatar name={name} id={message.sender.id ?? name} size={20} />
          <span className="max-w-[10rem] shrink-0 truncate text-sm font-medium">{name}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {snippet || t('email.message.noText')}
          </span>
          {hasFiles ? (
            <Paperclip aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          ) : null}
          <time
            dateTime={message.createdAt}
            className="tabular shrink-0 text-xs text-muted-foreground"
          >
            {exact}
          </time>
        </button>
      </article>
    );
  }

  const visibleHtml = split ? (showTrimmed || split.quoted === null ? html : split.visible) : null;
  const visibleText =
    showTrimmed || textSplit.quoted === null ? message.bodyText : textSplit.visible;

  return (
    <article
      data-message-kind={kind}
      data-email="expanded"
      aria-label={t(`timeline.kinds.${kind}`)}
      className={cn(shell, 'group/message relative')}
    >
      <header className="flex items-start gap-2 px-3 pt-3">
        <Avatar name={name} id={message.sender.id ?? name} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold text-foreground">{name}</span>
            {sender.address ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                &lt;{sender.address}&gt;
              </span>
            ) : null}
            {kind === 'reply' ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                {t('timeline.kinds.reply')}
              </span>
            ) : null}
            {message.direction === 'inbound' &&
            message.emailMeta?.senderAuth !== undefined &&
            message.emailMeta.senderAuth !== 'pass' ? (
              <span
                data-testid="unauthenticated-sender"
                title={t('email.message.unauthenticatedHint')}
                className="rounded-sm bg-surface-muted px-1.5 text-xs text-muted-foreground"
              >
                {t('email.message.unauthenticated')}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            aria-expanded={details}
            // The name starts with the words on the button (WCAG 2.5.3, label in name), then says what it does.
            aria-label={`${toLine}: ${details ? t('email.message.hideDetails') : t('email.message.showDetails')}`}
            onClick={() => {
              setDetails((open) => !open);
            }}
            className={cn(LINK, 'text-muted-foreground')}
          >
            {toLine}
            <ChevronDown aria-hidden className={cn('size-3.5', details && 'rotate-180')} />
          </button>
        </div>
        <Tooltip content={exact}>
          <time
            dateTime={message.createdAt}
            className="tabular shrink-0 text-xs text-muted-foreground"
          >
            {exact}
          </time>
        </Tooltip>
        {actions}
        <button
          type="button"
          aria-expanded
          aria-label={t('email.message.collapse', { name })}
          onClick={onToggle}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ChevronDown aria-hidden className="size-4 rotate-180" />
        </button>
      </header>
      {details ? (
        <div className="px-3">
          <Details message={message} />
        </div>
      ) : null}

      <div className="mt-1 px-1">
        {blocked > 0 && !showImages ? (
          <p className="mx-2 mb-1 flex flex-wrap items-center gap-2 rounded-md bg-surface-muted px-3 py-1.5 text-xs text-muted-foreground">
            <ImageOff aria-hidden className="size-3.5 shrink-0" />
            <span>{t('email.images.blocked', { count: blocked })}</span>
            <button
              type="button"
              onClick={() => {
                setShowImages(true);
              }}
              className={LINK}
            >
              {t('email.images.show')}
            </button>
          </p>
        ) : null}
        {visibleHtml !== null ? (
          <EmailBody
            html={visibleHtml}
            message={message}
            label={t('email.message.body', { name })}
            showImages={showImages}
            onBlockedImages={onBlocked}
          />
        ) : (
          <p className="px-3 py-2 text-sm break-words whitespace-pre-wrap text-foreground">
            {visibleText}
          </p>
        )}
        {quoted !== null ? (
          <div className="px-3 pb-2">
            <button
              type="button"
              aria-expanded={showTrimmed}
              onClick={() => {
                setShowTrimmed((open) => !open);
              }}
              className="inline-flex h-5 items-center rounded-full bg-surface-muted px-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              title={showTrimmed ? t('email.trimmed.hide') : t('email.trimmed.show')}
            >
              <span aria-hidden>···</span>
              <span className="sr-only">
                {showTrimmed ? t('email.trimmed.hide') : t('email.trimmed.show')}
              </span>
            </button>
          </div>
        ) : null}
      </div>

      <div className="px-3 pb-3">
        <MessageAttachments message={message} />
        {footer}
      </div>
    </article>
  );
}
