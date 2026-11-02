'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TicketDetail, TicketStatus, TimelineEntry } from '@watchtower/shared';
import { Button, SegmentedControl, Textarea, toast } from '@watchtower/ui';
import { useId, useState } from 'react';

import { PageHeader } from '@/components/admin/admin-page';
import { InvestigatePanel } from '@/components/ticket/investigate-panel';
import { StatusLabel } from '@/components/ticket/status-label';
import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { describeError } from '@/lib/admin/errors';
import { useUserId } from '@/lib/auth/session';
import { formatDateTime } from '@/lib/format';
import { isDetail, isStaffTicket } from '@/lib/tickets/model';

type Tab = 'waiting' | 'mine';
const LIST_LIMIT = 50;

/**
 * The developer's home (T-137): the tickets waiting on dev, and the ones this person picked up. The api
 * masks personal data for this role, so every text on this page is already masked; the page says so. A
 * developer reads the conversation, writes an internal note, picks a ticket up or lets it go, and hands
 * it between `open` and `waiting_on_dev` with a note. There is no reply box: a developer does not write
 * to the customer.
 */
export function DevHome() {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const [tab, setTab] = useState<Tab>('waiting');
  const [selected, setSelected] = useState<string | null>(null);
  const listId = useId();

  const list = useQuery({
    queryKey: ['user', userId, 'dev-home', 'list', tab],
    queryFn: ({ signal }) =>
      api.listTickets(
        tab === 'waiting'
          ? { status: ['waiting_on_dev'], sort: 'updated_desc', limit: LIST_LIMIT }
          : { devOwner: 'me', sort: 'updated_desc', limit: LIST_LIMIT },
        signal,
      ),
  });
  const items = (list.data?.items ?? []).filter(isStaffTicket);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title={t('devHome.title')} />
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[22rem_minmax(0,1fr)]">
        <section
          aria-label={t('devHome.listLabel')}
          className="flex min-h-0 flex-col gap-3 overflow-y-auto border-border/60 p-3 md:border-r"
        >
          <p className="text-xs text-muted-foreground">{t('devHome.masked')}</p>
          <SegmentedControl
            aria-label={t('devHome.tabsLabel')}
            value={tab}
            onValueChange={(value) => {
              setTab(value);
              setSelected(null);
            }}
            options={[
              { value: 'waiting', label: t('devHome.waiting') },
              { value: 'mine', label: t('devHome.mine') },
            ]}
          />
          {list.isPending ? <p role="status">{t('devHome.loading')}</p> : null}
          {list.isError ? (
            <p role="alert" className="text-sm text-danger">
              {t('devHome.loadFailed')}
            </p>
          ) : null}
          {list.isSuccess && items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {tab === 'waiting' ? t('devHome.emptyWaiting') : t('devHome.emptyMine')}
            </p>
          ) : null}
          <ul id={listId} className="flex flex-col gap-1">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-pressed={selected === item.key}
                  onClick={() => {
                    setSelected(item.key);
                  }}
                  className="flex w-full flex-col gap-0.5 rounded-md border border-border/60 px-3 py-2 text-left hover:bg-surface-muted aria-pressed:bg-primary-subtle"
                >
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{item.key}</span>
                    <span>{item.priority}</span>
                    <StatusLabel status={item.status} />
                  </span>
                  <span className="truncate text-sm font-medium">{item.subject}</span>
                  <span className="truncate text-xs text-muted-foreground">{item.org.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section id="pane-conversation" tabIndex={-1} className="min-h-0 overflow-y-auto p-4">
          {selected === null ? (
            <p className="text-sm text-muted-foreground">{t('devHome.pick')}</p>
          ) : (
            <DevTicket key={selected} reference={selected} />
          )}
        </section>
      </div>
    </div>
  );
}

function DevTicket({ reference }: { reference: string }) {
  const { t, locale } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const base = useId();
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const scope = ['user', userId, 'dev-home'] as const;
  const ticket = useQuery({
    queryKey: [...scope, 'ticket', reference],
    queryFn: ({ signal }) => api.getTicket(reference, signal),
  });
  const timeline = useQuery({
    queryKey: [...scope, 'timeline', reference],
    queryFn: ({ signal }) => api.timeline(reference, undefined, signal),
  });
  const brief = useQuery({
    queryKey: [...scope, 'brief', reference],
    queryFn: ({ signal }) => api.ticketAi(reference, signal),
    // 404 is "no brief yet", not a failure to retry.
    retry: false,
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: scope });
  };
  const fail = (cause: unknown): void => {
    setError(describeError(cause, t).message);
  };
  const succeed = async (): Promise<void> => {
    setError(null);
    toast(t('devHome.saved'));
    await refresh();
  };
  const addNote = useMutation({
    mutationFn: () => api.note(reference, { body: note.trim() }),
    onSuccess: async () => {
      setNote('');
      await succeed();
    },
    onError: fail,
  });
  const move = useMutation({
    mutationFn: (status: TicketStatus) =>
      api.changeStatus(reference, { status, reason: reason.trim() }),
    onSuccess: async () => {
      setReason('');
      await succeed();
    },
    onError: fail,
  });
  const owner = useMutation({
    mutationFn: (pick: boolean) => (pick ? api.devPickUp(reference) : api.devRelease(reference)),
    onSuccess: succeed,
    onError: fail,
  });

  const detail: TicketDetail | undefined =
    ticket.data !== undefined && isStaffTicket(ticket.data) && isDetail(ticket.data)
      ? ticket.data
      : undefined;
  if (ticket.isPending) return <p role="status">{t('devHome.loading')}</p>;
  if (detail === undefined) {
    return (
      <p role="alert" className="text-sm text-danger">
        {t('devHome.loadFailed')}
      </p>
    );
  }

  const mine = detail.devOwner?.id === userId;
  const messages = (timeline.data?.entries ?? []).filter(
    (entry): entry is Extract<TimelineEntry, { kind: 'message' }> => entry.kind === 'message',
  );
  const needReason = (status: TicketStatus): void => {
    if (reason.trim() === '') {
      setError(t('devHome.reasonRequired'));
      return;
    }
    move.mutate(status);
  };

  return (
    <article className="flex max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">
          <span className="font-mono">{detail.key}</span> · {detail.priority}
        </p>
        <h2 className="text-lg font-semibold">{detail.subject}</h2>
      </header>

      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t('devHome.org')}</dt>
        <dd>{detail.org.name}</dd>
        <dt className="text-muted-foreground">{t('devHome.requester')}</dt>
        <dd>
          {detail.requester?.name ?? '-'} {detail.requester?.email ?? ''}
        </dd>
        <dt className="text-muted-foreground">{t('devHome.status')}</dt>
        <dd>
          <StatusLabel status={detail.status} />
        </dd>
        <dt className="text-muted-foreground">{t('devHome.assignee')}</dt>
        <dd>{detail.assignee?.name ?? '-'}</dd>
        <dt className="text-muted-foreground">{t('devHome.devOwner')}</dt>
        <dd>
          {detail.devOwner === null || detail.devOwner === undefined
            ? t('devHome.ownerNone')
            : mine
              ? t('devHome.ownerYou')
              : detail.devOwner.name}
        </dd>
      </dl>

      <div className="flex flex-wrap gap-2">
        {mine ? (
          <Button
            variant="secondary"
            disabled={owner.isPending}
            onClick={() => {
              owner.mutate(false);
            }}
          >
            {t('devHome.release')}
          </Button>
        ) : detail.devOwner ? null : (
          <Button
            variant="primary"
            disabled={owner.isPending}
            onClick={() => {
              owner.mutate(true);
            }}
          >
            {t('devHome.pickUp')}
          </Button>
        )}
      </div>

      <section aria-labelledby={`${base}-brief`}>
        <h3 id={`${base}-brief`} className="mb-1 text-sm font-medium">
          {t('devHome.brief')}
        </h3>
        <p className="text-sm">{brief.data?.summary ?? t('devHome.briefNone')}</p>
      </section>

      <section aria-labelledby={`${base}-refs`}>
        <h3 id={`${base}-refs`} className="mb-1 text-sm font-medium">
          {t('devHome.references')}
        </h3>
        {(detail.references ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('devHome.referencesNone')}</p>
        ) : (
          <ul className="text-sm">
            {(detail.references ?? []).map((reference_) => (
              <li key={reference_.id}>{reference_.label}</li>
            ))}
          </ul>
        )}
      </section>

      {/* The saved read-only checks (T-203e): `dev` holds `investigate.run` but not `investigate.adhoc`. */}
      <InvestigatePanel ticketKey={detail.key} className="border-t border-border pt-3" />

      <section aria-labelledby={`${base}-conv`}>
        <h3 id={`${base}-conv`} className="mb-1 text-sm font-medium">
          {t('devHome.conversation')}
        </h3>
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('devHome.noMessages')}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {messages.map((message) => (
              <li key={message.id} className="rounded-md border border-border/60 p-3 text-sm">
                <p className="mb-1 text-xs text-muted-foreground">
                  {message.sender.name ?? '-'} · {formatDateTime(message.createdAt, locale)}
                  {message.visibility === 'internal' ? ` · ${t('devHome.internalNote')}` : ''}
                </p>
                <p className="whitespace-pre-wrap">{message.bodyText}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (note.trim() !== '') addNote.mutate();
        }}
      >
        <label htmlFor={`${base}-note`} className="text-sm font-medium">
          {t('devHome.note')}
        </label>
        <Textarea
          id={`${base}-note`}
          rows={3}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
        <div>
          <Button
            type="submit"
            variant="secondary"
            disabled={addNote.isPending || note.trim() === ''}
          >
            {t('devHome.addNote')}
          </Button>
        </div>
      </form>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${base}-reason`} className="text-sm font-medium">
          {t('devHome.reason')}
        </label>
        <Textarea
          id={`${base}-reason`}
          rows={2}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
        <div className="flex gap-2">
          {detail.status === 'waiting_on_dev' ? (
            <Button
              variant="primary"
              disabled={move.isPending}
              onClick={() => {
                needReason('open');
              }}
            >
              {t('devHome.handBack')}
            </Button>
          ) : detail.status === 'open' ? (
            <Button
              variant="secondary"
              disabled={move.isPending}
              onClick={() => {
                needReason('waiting_on_dev');
              }}
            >
              {t('devHome.handOver')}
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {t('devHome.failed')}: {error}
        </p>
      ) : null}
    </article>
  );
}
