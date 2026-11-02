'use client';

import {
  OTHER_MAIL_DISPOSITIONS,
  type OtherMailDetail,
  type OtherMailDisposition,
  type OtherMailItem,
} from '@watchtower/shared';
import { Alert, Button, cn, EmptyState, IconButton, Input, Select, Skeleton } from '@watchtower/ui';
import { ChevronsDown, Inbox, Lock, MailX } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { PageHeader } from '@/components/admin/admin-page';
import { AppLink } from '@/components/app-link';
import { RelativeTime } from '@/components/relative-time';
import { useT } from '@/i18n/provider';
import { ApiRequestError } from '@/lib/api/errors';
import { useSession } from '@/lib/auth/session';
import { useConvertOtherMail, useOtherMail, useOtherMailItem } from '@/lib/tickets/queries';

const SEARCH_DEBOUNCE_MS = 300;
const ALL = 'all';

type Filter = typeof ALL | OtherMailDisposition;

const isDisposition = (value: string): value is OtherMailDisposition =>
  (OTHER_MAIL_DISPOSITIONS as readonly string[]).includes(value);

/** Who sent it, in the words a person recognises: name and address, or either, or "unknown". */
function senderOf(item: Pick<OtherMailItem, 'fromAddress' | 'fromName'>): string | null {
  if (item.fromName && item.fromAddress) return `${item.fromName} <${item.fromAddress}>`;
  return item.fromName ?? item.fromAddress ?? null;
}

/**
 * "Other mail" (docs/06-UI-SPEC.md section 7, PRD R-2.6, R-2.7): everything received that did not
 * become a ticket, with why, and one action, "This is a ticket", for the ones the system got wrong.
 * Staff with `inbound.read`. Turning a message into a ticket sends nothing to the sender.
 */
export function OtherMailPage() {
  const { can } = useSession();
  if (!can('inbound.read')) return <Denied />;
  return <OtherMailBody canConvert={can('ticket.create')} />;
}

function Denied() {
  const t = useT();
  return (
    <main id="main-content" className="flex flex-1 items-center justify-center">
      <EmptyState
        icon={<Lock />}
        tone="amber"
        title={t('otherMail.denied.title')}
        description={t('otherMail.denied.body')}
      />
    </main>
  );
}

function OtherMailBody({ canConvert }: { canConvert: boolean }) {
  const t = useT();
  const [filter, setFilter] = useState<Filter>(ALL);
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The search box commits after a pause, like the queue's.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(draft.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [draft]);

  const params = useMemo(
    () => ({
      ...(filter === ALL ? {} : { disposition: [filter] }),
      ...(q.length >= 2 ? { q } : {}),
      limit: 50,
    }),
    [filter, q],
  );
  const list = useOtherMail(params, true);
  const items = useMemo(() => (list.data?.pages ?? []).flatMap((page) => page.items), [list.data]);
  const filtered = filter !== ALL || q.length >= 2;

  return (
    <main id="main-content" className="flex min-h-0 flex-1 flex-col">
      <PageHeader title={t('otherMail.title')} />
      <p className="px-4 py-2 text-sm text-muted-foreground">{t('otherMail.intro')}</p>
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4 md:flex-row">
        <section
          aria-label={t('otherMail.listLabel')}
          className="flex min-h-0 flex-col gap-2 md:w-[26rem] md:shrink-0"
        >
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1.5 text-sm">
              {t('otherMail.filter.label')}
              <Select
                value={filter}
                onChange={(event) => {
                  const value = event.target.value;
                  setFilter(isDisposition(value) ? value : ALL);
                  setSelectedId(null);
                }}
              >
                <option value={ALL}>{t('otherMail.filter.all')}</option>
                {OTHER_MAIL_DISPOSITIONS.map((value) => (
                  <option key={value} value={value}>
                    {t(`otherMail.filter.${value}`)}
                  </option>
                ))}
              </Select>
            </label>
            <Input
              type="search"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              aria-label={t('otherMail.search.label')}
              placeholder={t('otherMail.search.placeholder')}
              autoComplete="off"
              className="min-w-0 flex-1"
            />
          </div>

          <div aria-busy={list.isFetching} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {list.isPending ? (
              <div role="status" className="flex flex-col gap-2">
                <span className="sr-only">{t('otherMail.loading')}</span>
                {[0, 1, 2, 3].map((index) => (
                  <Skeleton key={index} className="h-14 rounded-xl" />
                ))}
              </div>
            ) : list.isError ? (
              <Alert tone="error" title={t('otherMail.error.title')}>
                <p>{t('otherMail.error.body')}</p>
                <Button
                  className="mt-2"
                  onClick={() => {
                    void list.refetch();
                  }}
                >
                  {t('errors.retry')}
                </Button>
              </Alert>
            ) : items.length === 0 ? (
              <EmptyState
                icon={filtered ? <MailX /> : <Inbox />}
                tone="sky"
                title={t(filtered ? 'otherMail.emptyFiltered.title' : 'otherMail.empty.title')}
                description={t(filtered ? 'otherMail.emptyFiltered.body' : 'otherMail.empty.body')}
              />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {items.map((item) => (
                  <li key={item.id}>
                    <MailRow
                      item={item}
                      current={item.id === selectedId}
                      onSelect={() => {
                        setSelectedId(item.id);
                      }}
                    />
                  </li>
                ))}
                {list.hasNextPage ? (
                  <li className="flex justify-center p-3">
                    <IconButton
                      variant="secondary"
                      label={
                        list.isFetchingNextPage
                          ? t('otherMail.loadingMore')
                          : t('otherMail.loadMore')
                      }
                      icon={<ChevronsDown aria-hidden className="size-4" />}
                      disabled={list.isFetchingNextPage}
                      onClick={() => {
                        void list.fetchNextPage();
                      }}
                    />
                  </li>
                ) : null}
              </ul>
            )}
          </div>
        </section>

        <section
          aria-label={t('otherMail.detailLabel')}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {selectedId === null ? (
            <p className="p-4 text-sm text-muted-foreground">{t('otherMail.select')}</p>
          ) : (
            <MailDetail
              key={selectedId}
              id={selectedId}
              canConvert={canConvert}
              onConverted={() => {
                setSelectedId(null);
              }}
            />
          )}
        </section>
      </div>
    </main>
  );
}

function MailRow({
  item,
  current,
  onSelect,
}: {
  item: OtherMailItem;
  current: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const sender = senderOf(item) ?? t('otherMail.unknownSender');
  return (
    <button
      type="button"
      aria-current={current ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        'flex w-full min-w-0 flex-col gap-0.5 rounded-xl px-2.5 py-2 text-left transition-colors duration-(--wt-motion-duration-fast) ease-out hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-ring',
        current && 'bg-primary-subtle hover:bg-primary-subtle',
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {item.subject === '' ? t('otherMail.noSubject') : item.subject}
        </span>
        <RelativeTime iso={item.receivedAt} className="shrink-0 text-xs text-muted-foreground" />
      </span>
      <span className="truncate text-xs text-muted-foreground">{sender}</span>
      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="shrink-0 rounded-full bg-surface-muted px-2 py-px">
          {t(`otherMail.kind.${item.disposition}`)}
        </span>
        <span className="truncate">{item.snippet}</span>
      </span>
    </button>
  );
}

/** Why the message is in Other mail, from what the rules and the classifier recorded. */
function Reason({ detail }: { detail: OtherMailDetail }) {
  const t = useT();
  const lines: string[] = [];
  if (detail.automatedSubtype) {
    lines.push(t('otherMail.reasonRules', { subtype: detail.automatedSubtype }));
  }
  if (detail.classification) {
    const source = t(
      detail.classification.source === 'ai' ? 'otherMail.sourceAi' : 'otherMail.sourceRules',
    );
    lines.push(
      detail.classification.confidence === null
        ? t('otherMail.classifiedNoConfidence', { type: detail.classification.type, source })
        : t('otherMail.classified', {
            type: detail.classification.type,
            confidence: Math.round(detail.classification.confidence * 100),
            source,
          }),
    );
  }
  if (lines.length === 0) lines.push(t('otherMail.noReason'));
  return (
    <div>
      <h3 className="text-sm font-medium">{t('otherMail.why')}</h3>
      <ul className="m-0 mt-1 list-none p-0 text-sm text-muted-foreground">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function MailDetail({
  id,
  canConvert,
  onConverted,
}: {
  id: string;
  canConvert: boolean;
  onConverted: () => void;
}) {
  const t = useT();
  const detail = useOtherMailItem(id);
  const convert = useConvertOtherMail();
  const [converted, setConverted] = useState<string | null>(null);

  // Once it is a ticket the message leaves Other mail, so the detail would be gone (404): say what
  // happened and offer the ticket instead of an error.
  if (converted !== null) {
    return (
      <Alert tone="success" title={t('otherMail.converted', { key: converted })}>
        <Button asChild className="mt-2">
          <AppLink href={`/?ticket=${encodeURIComponent(converted)}`} onClick={onConverted}>
            {t('otherMail.openTicket', { key: converted })}
          </AppLink>
        </Button>
      </Alert>
    );
  }

  if (detail.isPending) {
    return (
      <div role="status" className="flex flex-col gap-2 p-2">
        <span className="sr-only">{t('otherMail.loading')}</span>
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <Alert tone="error" title={t('otherMail.error.title')}>
        <p>{t('otherMail.error.body')}</p>
      </Alert>
    );
  }

  const mail = detail.data;
  const sender = senderOf(mail) ?? t('otherMail.unknownSender');
  const errorStatus =
    convert.error instanceof ApiRequestError ? convert.error.status : convert.isError ? 0 : null;
  const errorText =
    errorStatus === null
      ? null
      : errorStatus === 409
        ? t('otherMail.convertErrors.conflict')
        : errorStatus === 404
          ? t('otherMail.convertErrors.not_found')
          : errorStatus === 403
            ? t('otherMail.convertErrors.forbidden')
            : t('otherMail.convertFailed');

  return (
    <article className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-xl border border-border/60 p-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">
          {mail.subject === '' ? t('otherMail.noSubject') : mail.subject}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('otherMail.fromLine', { sender })} · {t('otherMail.receivedAt')}{' '}
          <RelativeTime iso={mail.receivedAt} />
          {mail.attachmentCount > 0
            ? ` · ${t('otherMail.attachments', { count: mail.attachmentCount })}`
            : ''}
        </p>
        <p>
          <span className="rounded-full bg-surface-muted px-2 py-px text-xs">
            {t(`otherMail.kind.${mail.disposition}`)}
          </span>
        </p>
      </header>

      <Reason detail={mail} />

      <div>
        <h3 className="text-sm font-medium">{t('otherMail.body')}</h3>
        <pre className="mt-1 max-h-[24rem] overflow-auto rounded-lg bg-surface-muted p-3 font-sans text-sm break-words whitespace-pre-wrap">
          {mail.bodyText === '' ? t('otherMail.bodyEmpty') : mail.bodyText}
        </pre>
      </div>

      {canConvert ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">{t('otherMail.convertHint')}</p>
          <div>
            <Button
              disabled={convert.isPending}
              onClick={() => {
                convert.mutate(
                  { id },
                  {
                    onSuccess: (result) => {
                      setConverted(result.ticketKey);
                    },
                  },
                );
              }}
            >
              {convert.isPending ? t('otherMail.converting') : t('otherMail.convert')}
            </Button>
          </div>
          {errorText ? (
            <p role="alert" className="text-sm text-danger">
              {errorText}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
