'use client';

import type { AiDraft, AiRejectReason } from '@watchtower/shared';
import { Button, cn, Kbd, toast } from '@watchtower/ui';
import { PenLine, TriangleAlert } from 'lucide-react';
import { Fragment, useEffect, useId, useRef, useState } from 'react';

import { useI18n } from '@/i18n/provider';
import { changedFraction } from '@/lib/ai/model';
import { useAiDraftActions } from '@/lib/ai/queries';
import {
  isScheduled,
  scheduleSend,
  type ScheduledSend,
  UNDO_WINDOW_MS,
} from '@/lib/ai/send-with-undo';
import { useShortcut } from '@/lib/keyboard';
import { isDetail, type TicketItem } from '@/lib/tickets/model';
import { useTicketMutations } from '@/lib/tickets/queries';

import { ApproveDialog, RejectDialog } from './draft-dialogs';

/** Counts down the undo window in whole seconds. */
function Countdown({ until }: { until: number }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 250);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return <>{t('ai.draft.sending', { seconds: Math.max(0, Math.ceil((until - now) / 1000)) })}</>;
}

/** The draft text with its `[n]` markers turned into buttons that open the cited evidence. */
function DraftText({
  text,
  citations,
  onOpenEvidence,
}: {
  text: string;
  citations: readonly string[];
  onOpenEvidence: (id: string) => void;
}) {
  const { t } = useI18n();
  const parts = text.split(/(\[\d+\])/u);
  return (
    <p className="text-sm break-words whitespace-pre-wrap text-foreground">
      {parts.map((part, index) => {
        const number = /^\[(\d+)\]$/u.exec(part)?.[1];
        const evidenceId = number ? citations[Number(number) - 1] : undefined;
        if (!evidenceId) return <Fragment key={index}>{part}</Fragment>;
        return (
          <button
            key={index}
            type="button"
            aria-label={t('ai.draft.citation', { number: number ?? '' })}
            onClick={() => {
              onOpenEvidence(evidenceId);
            }}
            className="rounded align-baseline text-xs font-medium text-link hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {part}
          </button>
        );
      })}
    </p>
  );
}

/**
 * The AI's draft reply under the brief, with Approve (A), Edit (E) and Reject (R)
 * (docs/06-UI-SPEC.md section 6.3, docs/design/ai-first-workspace.md section 3).
 *  - Approve opens a preview; confirming it starts the send, which waits out the undo window
 *    (N3: a person decided, nothing is sent on its own);
 *  - Edit changes the text in place; the card then says how much changed, and Approve sends the
 *    edited text;
 *  - Reject asks for a reason code.
 * A, E and R are single-key shortcuts: they obey the preference, never fire while typing, and
 * are off while a dialog is open (see `isShortcut`). On a phone the buttons stick to the bottom
 * edge with 44px targets.
 */
export function AiDraftCard({
  ticket,
  draft,
  onOpenEvidence,
  approveOpen,
  onApproveOpenChange,
}: {
  ticket: TicketItem;
  draft: AiDraft;
  onOpenEvidence: (id: string) => void;
  /** The approve preview is open. Owned by the brief, whose primary button can open it too. */
  approveOpen: boolean;
  onApproveOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const headingId = useId();
  const { reply } = useTicketMutations(ticket.key);
  const actions = useAiDraftActions(ticket.key);
  const [edited, setEdited] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [scheduled, setScheduled] = useState<{ handle: ScheduledSend; until: number } | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);

  const text = edited ?? draft.body;
  const changed = edited === null ? null : Math.round(changedFraction(draft.body, edited) * 100);
  const sending = scheduled !== null;
  const busy = sending || approveOpen || rejectOpen;

  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);

  const startApprove = () => {
    if (editing) setEditing(false);
    onApproveOpenChange(true);
  };
  const startEdit = () => {
    setEdited((current) => current ?? draft.body);
    setEditing(true);
  };
  const startReject = () => {
    setRejectOpen(true);
  };

  useShortcut('a', startApprove, !busy && !editing);
  useShortcut('e', startEdit, !busy && !editing);
  useShortcut('r', startReject, !busy && !editing);

  const toastId = `ai-send-${draft.id}`;
  const undo = () => {
    scheduled?.handle.cancel();
    setScheduled(null);
    toast.dismiss(toastId);
  };
  useShortcut('u', undo, sending);

  const confirm = () => {
    onApproveOpenChange(false);
    if (isScheduled(draft.id)) {
      toast(t('ai.draft.alreadySending'));
      return;
    }
    const body = text.trim();
    const handle = scheduleSend(draft.id, (done) => {
      reply
        .mutateAsync({ body })
        .then(() => {
          actions.sent(draft.id);
          toast(t('ai.draft.sent'));
        })
        .catch(() => {
          toast(t('ai.draft.sendFailed'));
        })
        .finally(() => {
          done();
          setScheduled(null);
        });
    });
    setScheduled({ handle, until: Date.now() + UNDO_WINDOW_MS });
    toast(t('ai.draft.sending', { seconds: UNDO_WINDOW_MS / 1000 }), {
      id: toastId,
      duration: UNDO_WINDOW_MS,
      action: {
        label: t('ai.draft.undo'),
        onClick: () => {
          handle.cancel();
          setScheduled(null);
        },
      },
    });
  };

  const submitReject = (reason: AiRejectReason, comment: string) => {
    actions.reject.mutate(
      { draftId: draft.id, body: { reason, ...(comment ? { comment } : {}) } },
      {
        onSuccess: () => {
          setRejectOpen(false);
          toast(t('ai.reject.done'));
        },
      },
    );
  };

  const channel = 'channel' in ticket ? t(`channel.${ticket.channel}`) : '';
  const recipient = isDetail(ticket) ? (ticket.requester?.name ?? null) : null;

  return (
    <section
      aria-labelledby={headingId}
      data-testid="ai-draft"
      className="mx-4 mt-2 flex flex-col gap-2 rounded-lg border border-ai-accent/50 bg-surface px-3 py-2.5"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <PenLine aria-hidden className="size-3.5 text-ai-accent" />
        <h4 id={headingId} className="text-sm font-medium text-foreground">
          {t('ai.draft.label')}
        </h4>
        {changed !== null ? (
          <span className="rounded-full border border-border px-1.5">
            {t('ai.draft.edited', { percent: changed })}
          </span>
        ) : null}
        {draft.uncitedClaims > 0 ? (
          <span
            title={t('ai.brief.uncitedTip')}
            className="inline-flex items-center gap-1 rounded-full border border-border-strong px-1.5 font-medium text-foreground"
          >
            <TriangleAlert aria-hidden className="size-3.5" />
            {t('ai.brief.uncited', { count: draft.uncitedClaims })}
          </span>
        ) : null}
      </header>

      {editing ? (
        <textarea
          ref={editRef}
          aria-label={t('ai.draft.editField')}
          value={text}
          rows={Math.min(12, Math.max(4, text.split('\n').length + 1))}
          onChange={(event) => {
            setEdited(event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Escape' ||
              (event.key === 'Enter' && (event.ctrlKey || event.metaKey))
            ) {
              event.preventDefault();
              event.stopPropagation();
              setEditing(false);
            }
          }}
          className="w-full resize-y rounded-md border border-border-strong bg-surface px-2.5 py-2 text-sm leading-normal text-foreground"
        />
      ) : (
        <DraftText text={text} citations={draft.citations} onOpenEvidence={onOpenEvidence} />
      )}

      <div
        role="group"
        aria-label={t('ai.draft.actions')}
        className={cn(
          'flex flex-wrap items-center gap-2',
          'max-md:sticky max-md:bottom-0 max-md:-mx-3 max-md:-mb-2.5 max-md:border-t max-md:border-border max-md:bg-surface max-md:px-3 max-md:py-2',
        )}
      >
        {sending ? (
          <>
            <p role="status" className="text-sm text-muted-foreground">
              <Countdown until={scheduled.until} />
            </p>
            <Button className="max-md:min-h-[44px]" onClick={undo}>
              {t('ai.draft.undo')}
              <Kbd>U</Kbd>
            </Button>
          </>
        ) : editing ? (
          <>
            <Button
              variant="primary"
              className="max-md:min-h-[44px]"
              onClick={() => {
                setEditing(false);
              }}
            >
              {t('ai.draft.done')}
            </Button>
            <Button
              className="max-md:min-h-[44px]"
              onClick={() => {
                setEdited(null);
                setEditing(false);
              }}
            >
              {t('ai.draft.revert')}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="primary"
              aria-keyshortcuts="A"
              className="max-md:min-h-[44px] max-md:min-w-[44px] max-md:flex-1"
              disabled={busy}
              onClick={startApprove}
            >
              {t('ai.draft.approve')}
              <Kbd className="max-md:hidden border-transparent bg-primary-foreground/20 text-primary-foreground">
                A
              </Kbd>
            </Button>
            <Button
              aria-keyshortcuts="E"
              className="max-md:min-h-[44px] max-md:min-w-[44px] max-md:flex-1"
              disabled={busy}
              onClick={startEdit}
            >
              {t('ai.draft.edit')}
              <Kbd className="max-md:hidden">E</Kbd>
            </Button>
            <Button
              aria-keyshortcuts="R"
              className="max-md:min-h-[44px] max-md:min-w-[44px] max-md:flex-1"
              disabled={busy}
              onClick={startReject}
            >
              {t('ai.draft.reject')}
              <Kbd className="max-md:hidden">R</Kbd>
            </Button>
          </>
        )}
      </div>

      <ApproveDialog
        open={approveOpen}
        onOpenChange={onApproveOpenChange}
        body={text}
        recipient={recipient}
        channel={channel}
        uncited={draft.uncitedClaims}
        changedPercent={changed}
        onConfirm={confirm}
      />
      <RejectDialog
        open={rejectOpen}
        onOpenChange={(next) => {
          if (!next) actions.reject.reset();
          setRejectOpen(next);
        }}
        onSubmit={submitReject}
        pending={actions.reject.isPending}
        failed={actions.reject.isError}
      />
    </section>
  );
}
