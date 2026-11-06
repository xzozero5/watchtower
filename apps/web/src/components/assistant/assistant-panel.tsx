'use client';

import type { AssistantEntity, AssistantReply, AssistantState } from '@watchtower/shared';
import { Button, cn, IconButton, Sheet, SheetContent, Skeleton, TintChip } from '@watchtower/ui';
import {
  Bot,
  CirclePause,
  Copy,
  CloudOff,
  Check,
  RefreshCw,
  SendHorizontal,
  Square,
  Trash2,
  Wallet,
  X,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { AppLink } from '@/components/app-link';
import { ClaimLine } from '@/components/claims/claim-line';
import { useI18n } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { ASSISTANT_SURFACE_ATTRIBUTE } from '@/lib/assistant/use-bubble-room';
import { SIDE_BY_SIDE_QUERY, useMediaQuery } from '@/lib/use-media-query';
import {
  contextForRequest,
  contextKey,
  NONE_REMOVED,
  type PageContext,
} from '@/lib/assistant/page-context';
import { entityNeedsLocalStarters, entityStarters, pageStarters } from '@/lib/assistant/starters';
import {
  useAssistantChat,
  useAssistantStarters,
  type ChatErrorKind,
} from '@/lib/assistant/use-assistant-chat';

import { ProposalCard } from './proposal-card';

const CLOSED_STATES: readonly AssistantState[] = ['paused', 'budget', 'unavailable'];

/** Plain text of an answer, for the Copy button: each sentence, with its sources in brackets. */
export function answerText(reply: AssistantReply): string {
  return reply.claims
    .map((claim) =>
      claim.evidence.length === 0
        ? claim.text
        : `${claim.text} [${claim.evidence.map((item) => item.label).join(', ')}]`,
    )
    .join('\n');
}

export interface AssistantPanelProps {
  id: string;
  context: PageContext;
  /** False while the panel is folded away: it stays mounted so the thread and the typed text stay. */
  open: boolean;
  /** Closes the panel; the bubble gives focus back to its button. */
  onClose: () => void;
  /** The sheet has gone: put focus back (it cannot move while the sheet still traps it). */
  onClosed: () => void;
}

/**
 * The chat panel (docs/design/less-text-ai-assistant.md section 2). A non-modal dialog so the page
 * beside it stays readable and a link to evidence can be followed with the panel open; on a small
 * screen it fills the window. Esc closes it, the typed text stays. The thread is a polite `log`
 * that announces "The answer is ready" once, never token by token.
 */
export function AssistantPanel({ id, context, open, onClose, onClosed }: AssistantPanelProps) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const titleId = useId();
  const chat = useAssistantChat();
  const phone = !useMediaQuery(SIDE_BY_SIDE_QUERY);
  const [text, setText] = useState('');
  const here = contextKey(context);
  const [removedAt, setRemovedAt] = useState({ here: '', ...NONE_REMOVED });
  const [copied, setCopied] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const thread = useRef<HTMLDivElement>(null);

  // A chip the person removed stays removed for that page and ticket only; a new place is new context.
  const removed = removedAt.here === here ? removedAt : NONE_REMOVED;

  const entity = removed.entity ? null : context.entity;
  const selection = removed.selection ? null : context.selection;
  const pageChip = !removed.page;
  const ticketChip = entity?.kind === 'ticket';
  const starters = useAssistantStarters({
    enabled: open,
    locale,
    page: pageChip ? context.page : undefined,
    ticket: ticketChip ? entity.ref : null,
  });
  const state: AssistantState = chat.state !== 'ok' ? chat.state : (starters.data?.state ?? 'ok');
  const closed = CLOSED_STATES.includes(state);

  useEffect(() => {
    // The sheet on a phone focuses the box itself once its content is mounted (onOpenAutoFocus).
    if (open && !phone) input.current?.focus();
  }, [open, phone]);
  // New content: keep the latest in view without stealing focus.
  useEffect(() => {
    const element = phone ? thread.current?.parentElement : thread.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [chat.turns.length, chat.pending, chat.error, phone]);

  const submit = (value: string) => {
    if (closed || chat.pending || value.trim() === '') return;
    chat.send(value, locale, contextForRequest(context, removed));
    setText('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit(text);
    }
  };

  const onPanelKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.stopPropagation();
    onClose();
  };

  const copy = (messageId: string, reply: AssistantReply) => {
    void navigator.clipboard.writeText(answerText(reply)).then(() => {
      setCopied(messageId);
    });
  };

  const empty = chat.turns.length === 0 && !chat.pending;
  const pageName = t(`assistant.context.page.${context.page}`);
  // The api's prompts know the page and a ticket; every other entity (and a failed call) uses the web's own.
  const localOnly = entityNeedsLocalStarters(entity?.kind ?? null);
  const serverStarters = localOnly ? [] : (starters.data?.starters ?? []);
  const shownStarters =
    entity !== null && localOnly
      ? entityStarters(entity.kind).map((item) => ({ id: item.id, text: t(item.key) }))
      : serverStarters.length > 0
        ? serverStarters
        : starters.isPending
          ? []
          : pageStarters(pageChip ? context.page : 'other').map((item) => ({
              id: item.id,
              text: t(item.key),
            }));
  const entityLabel = entity === null ? null : entityChipLabel(t, entity, context.label);
  const selectionLabel =
    selection === null
      ? null
      : t('assistant.context.selection', {
          count: selection.refs.length,
          kind: t(`assistant.context.entity.${selection.kind}`),
        });
  const remaining = starters.data?.limits.remainingThisHour;

  const headerEl = (
    <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-ai-subtle text-ai-accent">
          <Bot aria-hidden className="size-4" />
        </span>
        <h2 id={titleId} className="truncate text-base font-semibold">
          {t('assistant.name')}
        </h2>
      </div>
      <div className="flex items-center gap-1">
        {chat.turns.length > 0 ? (
          <IconButton
            label={t('assistant.newChat')}
            tooltip={t('assistant.newChatTip')}
            icon={<Trash2 />}
            onClick={() => {
              chat.clear();
              input.current?.focus();
            }}
          />
        ) : null}
        <IconButton
          label={t('assistant.close')}
          shortcut={['Esc']}
          icon={<X />}
          onClick={onClose}
        />
      </div>
    </header>
  );
  const descriptionEl = (
    <p className="px-4 pt-2 text-xs text-muted-foreground">{t('assistant.description')}</p>
  );
  const threadEl = (
    <div
      ref={thread}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-busy={chat.pending}
      aria-label={t('assistant.thread.label')}
      className={cn(
        'flex flex-col gap-3',
        // The sheet scrolls itself on a phone; the floating panel scrolls its thread.
        !phone && 'min-h-0 flex-1 overflow-y-auto px-4 py-3',
      )}
    >
      {state !== 'ok' && closed ? (
        <StateNotice state={state} canControl={can('ai.autonomy.set')} />
      ) : null}

      {empty && !closed ? (
        <div className="flex flex-col gap-2">
          {starters.isPending && !localOnly ? (
            <div
              aria-label={t('assistant.starters.loading')}
              role="status"
              className="flex flex-col gap-2"
            >
              <Skeleton className="h-8 w-3/4" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : shownStarters.length > 0 ? (
            <>
              <p className="text-xs font-medium text-muted-foreground">
                {t('assistant.starters.label')}
              </p>
              <ul className="flex flex-col items-start gap-2">
                {shownStarters.map((starter) => (
                  <li key={starter.id} className="max-w-full">
                    <Button
                      variant="secondary"
                      className="h-auto max-w-full py-1.5 text-left whitespace-normal"
                      onClick={() => {
                        submit(starter.text);
                      }}
                    >
                      {starter.text}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {chat.turns.map((turn) =>
        turn.kind === 'user' ? (
          <div key={turn.id} className="flex flex-col items-end gap-0.5">
            <span className="text-[11px] text-muted-foreground">{t('assistant.thread.you')}</span>
            <p className="max-w-[90%] rounded-card bg-primary-subtle px-3 py-2 text-sm break-words whitespace-pre-wrap">
              {turn.text}
            </p>
          </div>
        ) : (
          <div key={turn.id} className="flex flex-col gap-2" data-testid="assistant-answer">
            <span className="text-[11px] text-muted-foreground">{t('assistant.thread.ai')}</span>
            {turn.reply.claims.length > 0 ? (
              <ul className="flex flex-col gap-3 rounded-card bg-ai-subtle p-3 ring-1 ring-ai-accent/20 ring-inset">
                {turn.reply.claims.map((claim, index) => (
                  <ClaimLine key={index} claim={claim} onOpen={closeOnPhone(onClose)} />
                ))}
              </ul>
            ) : turn.reply.proposals.length === 0 && turn.reply.state === 'ok' ? (
              <div className="rounded-card bg-ai-subtle p-3 text-sm ring-1 ring-ai-accent/20 ring-inset">
                <p className="font-medium">{t('assistant.answer.noEvidence')}</p>
                <p className="text-muted-foreground">{t('assistant.answer.noEvidenceBody')}</p>
              </div>
            ) : null}

            {turn.reply.proposals.map((card) => {
              const view = chat.proposals[card.id];
              return view ? (
                <ProposalCard
                  key={card.id}
                  view={view}
                  onConfirm={(proposalId) => {
                    void chat.confirm(proposalId);
                  }}
                  onReject={(proposalId) => {
                    void chat.reject(proposalId);
                  }}
                  onOpen={closeOnPhone(onClose)}
                />
              ) : null;
            })}

            {turn.reply.tools.length > 0 ? (
              <details className="text-xs text-muted-foreground">
                <summary className="w-fit cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  {t('assistant.answer.steps', { count: turn.reply.tools.length })}
                </summary>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {turn.reply.tools.map((tool, index) => (
                    <li key={index} className="flex flex-wrap items-center gap-1.5">
                      <code>{tool.name}</code>
                      <span>
                        {tool.status === 'ok'
                          ? t('assistant.answer.stepOk')
                          : tool.status === 'denied'
                            ? t('assistant.answer.stepDenied')
                            : t('assistant.answer.stepError')}
                      </span>
                      {tool.mock ? (
                        <TintChip tone="slate" title={t('assistant.answer.demoTip')}>
                          {t('assistant.answer.demo')}
                        </TintChip>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            {turn.reply.claims.length > 0 ? (
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    copy(turn.id, turn.reply);
                  }}
                >
                  {copied === turn.id ? (
                    <Check aria-hidden className="size-3.5" />
                  ) : (
                    <Copy aria-hidden className="size-3.5" />
                  )}
                  {copied === turn.id ? t('assistant.answer.copied') : t('assistant.answer.copy')}
                </Button>
              </div>
            ) : null}
          </div>
        ),
      )}

      {chat.pending ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Bot aria-hidden className="size-4 text-ai-accent motion-safe:animate-pulse" />
          {t('assistant.thread.thinking')}
        </p>
      ) : null}

      {chat.stopped ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('assistant.thread.stopped')}
        </p>
      ) : null}

      {chat.error !== null ? (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-card bg-surface-muted p-3 text-sm"
        >
          <p>{errorText(chat.error, t)}</p>
          {chat.error === 'generic' || chat.error === 'rate' ? (
            <Button size="sm" onClick={chat.retry}>
              <RefreshCw aria-hidden className="size-3.5" />
              {t('assistant.error.retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <p className="sr-only" role="status">
        {chat.turns.at(-1)?.kind === 'ai' && !chat.pending ? t('assistant.thread.ready') : ''}
      </p>
    </div>
  );
  const footerEl = (
    <footer
      className={cn('flex flex-col gap-2', phone ? 'w-full' : 'border-t border-border px-4 py-3')}
    >
      <div
        className="flex flex-wrap items-center gap-1.5"
        aria-label={t('assistant.context.label')}
        role="group"
      >
        {!removed.element && context.element ? (
          <ContextChip
            label={`${context.label ?? context.element.key} · ${context.element.scope}${context.element.period ? ` · ${context.element.period}` : ''}`}
            removeLabel={t('assistant.context.remove', {
              name: context.label ?? context.element.key,
            })}
            onRemove={() => {
              setRemovedAt({ ...removed, here, element: true });
            }}
          />
        ) : null}
        {pageChip ? (
          <ContextChip
            label={pageName}
            removeLabel={t('assistant.context.remove', { name: pageName })}
            onRemove={() => {
              setRemovedAt({ ...removed, here, page: true });
            }}
          />
        ) : null}
        {entityLabel !== null ? (
          <ContextChip
            label={entityLabel}
            removeLabel={t('assistant.context.remove', { name: entityLabel })}
            onRemove={() => {
              setRemovedAt({ ...removed, here, entity: true });
            }}
          />
        ) : null}
        {selectionLabel !== null ? (
          <ContextChip
            label={selectionLabel}
            removeLabel={t('assistant.context.remove', { name: selectionLabel })}
            onRemove={() => {
              setRemovedAt({ ...removed, here, selection: true });
            }}
          />
        ) : null}
      </div>

      <div className="flex items-end gap-2">
        <textarea
          ref={input}
          value={text}
          rows={2}
          maxLength={2000}
          disabled={closed}
          aria-label={t('assistant.input.label')}
          placeholder={t('assistant.input.placeholder')}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={onKeyDown}
          className="min-h-control flex-1 resize-none rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:opacity-50"
        />
        {chat.pending ? (
          <IconButton label={t('assistant.input.stop')} icon={<Square />} onClick={chat.stop} />
        ) : (
          <IconButton
            label={t('assistant.input.send')}
            variant="primary"
            icon={<SendHorizontal />}
            disabled={closed || text.trim() === ''}
            onClick={() => {
              submit(text);
            }}
          />
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t('assistant.input.hint')}
        {remaining !== undefined ? ` · ${t('assistant.input.left', { count: remaining })}` : ''}
      </p>
    </footer>
  );

  // Below 768 px: a sheet on the same dialog primitive as every drawer, so focus is trapped, the page
  // behind is inert for assistive technology, and Esc closes it. The chat state lives here, so closing
  // the sheet keeps the thread and the typed text.
  if (phone) {
    return (
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <SheetContent
          id={id}
          title={t('assistant.name')}
          description={t('assistant.description')}
          closeLabel={t('assistant.close')}
          footer={footerEl}
          data-testid="assistant-panel"
          {...{ [ASSISTANT_SURFACE_ATTRIBUTE]: '' }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            // There is no trigger for Radix to return to; the bubble knows where focus goes.
            event.preventDefault();
            onClosed();
          }}
        >
          {chat.turns.length > 0 ? (
            <div className="mb-3">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  chat.clear();
                  input.current?.focus();
                }}
              >
                <Trash2 aria-hidden className="size-3.5" />
                {t('assistant.newChat')}
              </Button>
            </div>
          ) : null}
          {threadEl}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <section
      id={id}
      role="dialog"
      aria-modal="false"
      hidden={!open}
      aria-labelledby={titleId}
      onKeyDown={onPanelKeyDown}
      data-testid="assistant-panel"
      {...{ [ASSISTANT_SURFACE_ATTRIBUTE]: '' }}
      className="fixed inset-0 z-30 flex flex-col [&[hidden]]:hidden bg-surface text-foreground md:inset-auto md:right-4 md:bottom-20 md:h-[min(40rem,calc(100dvh-7rem))] md:w-[25rem] md:rounded-app md:shadow-overlay md:ring-1 md:ring-border md:ring-inset"
    >
      {headerEl}
      {descriptionEl}
      {threadEl}
      {footerEl}
    </section>
  );
}

/** On a phone the panel covers the page, so following a link closes it; beside the page it stays. */
function closeOnPhone(close: () => void): () => void {
  return () => {
    if (
      typeof window.matchMedia === 'function' &&
      !window.matchMedia('(min-width: 48rem)').matches
    ) {
      close();
    }
  };
}

/** The chip of an entity says its kind and what it is, exactly what is sent (a ticket is its key). */
function entityChipLabel(
  t: ReturnType<typeof useI18n>['t'],
  entity: AssistantEntity,
  label: string | null,
): string {
  const name = label ?? entity.ref;
  return entity.kind === 'ticket'
    ? name
    : t('assistant.context.entityChip', {
        kind: t(`assistant.context.entity.${entity.kind}`),
        name,
      });
}

function ContextChip({
  label,
  removeLabel,
  onRemove,
}: {
  label: string;
  removeLabel: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted py-0.5 pr-0.5 pl-2 text-xs ring-1 ring-border ring-inset">
      {label}
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        className="inline-flex size-5 items-center justify-center rounded-full hover:bg-primary-subtle focus-visible:outline-2 focus-visible:outline-ring"
      >
        <X aria-hidden className="size-3" />
      </button>
    </span>
  );
}

function errorText(kind: ChatErrorKind, t: ReturnType<typeof useI18n>['t']): string {
  switch (kind) {
    case 'forbidden':
      return t('assistant.error.forbidden');
    case 'rate':
      return t('assistant.error.rate');
    case 'notFound':
      return t('assistant.error.notFound');
    default:
      return t('assistant.error.generic');
  }
}

/** Paused, over budget or offline: the input is closed and the words say why (never an icon alone). */
function StateNotice({ state, canControl }: { state: AssistantState; canControl: boolean }) {
  const { t } = useI18n();
  const Icon = state === 'paused' ? CirclePause : state === 'budget' ? Wallet : CloudOff;
  const title =
    state === 'paused'
      ? t('assistant.state.paused')
      : state === 'budget'
        ? t('assistant.state.budget')
        : t('assistant.state.unavailable');
  const body =
    state === 'paused'
      ? t('assistant.state.pausedBody')
      : state === 'budget'
        ? t('assistant.state.budgetBody')
        : t('assistant.state.unavailableBody');
  return (
    <div
      role="status"
      data-testid="assistant-state"
      data-state={state}
      className="flex gap-2 rounded-card bg-surface-muted p-3 text-sm"
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex flex-col gap-1">
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground">{body}</p>
        {canControl && state !== 'unavailable' ? (
          <AppLink
            href="/admin/ai"
            className="w-fit rounded-sm text-link underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t('assistant.state.controls')}
          </AppLink>
        ) : null}
      </div>
    </div>
  );
}
