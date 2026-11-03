'use client';

import type { AiDraft, AiEvidence, AiRejectReason } from '@watchtower/shared';
import { Button, cn, IconButton, TintChip, toast, Tooltip } from '@watchtower/ui';
import {
  Check,
  Languages,
  Pencil,
  PenLine,
  RotateCcw,
  ShieldAlert,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useId, useRef, useState } from 'react';

import { textToHtml } from '@/components/conversation/email/html';
import { useI18n } from '@/i18n/provider';
import { changedFraction } from '@/lib/ai/model';
import { useAiDraftActions } from '@/lib/ai/queries';
import { useShortcut } from '@/lib/keyboard';
import { isDraftPending } from '@/lib/outbound/pending-sends';
import { useSendUndo } from '@/lib/outbound/queries';
import { usePreferences } from '@/lib/preferences';
import { isDetail, type TicketItem } from '@/lib/tickets/model';
import { useTicketMutations } from '@/lib/tickets/queries';

import { ApproveDialog, RejectDialog } from './draft-dialogs';
import { EVIDENCE_ICONS } from './evidence-icons';

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
  evidence,
  onOpenEvidence,
  approveOpen,
  onApproveOpenChange,
}: {
  ticket: TicketItem;
  draft: AiDraft;
  /** The evidence of the brief; the cards the draft cites are listed under its text. */
  evidence: readonly AiEvidence[];
  onOpenEvidence: (id: string) => void;
  /** The approve preview is open. Owned by the brief, whose primary button can open it too. */
  approveOpen: boolean;
  onApproveOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const { singleKeyShortcuts } = usePreferences();
  const headingId = useId();
  const { reply } = useTicketMutations(ticket.key);
  const { offer } = useSendUndo(ticket.key);
  const actions = useAiDraftActions(ticket.key);
  const [edited, setEdited] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);

  const cited = evidence.filter((entry) => draft.citations.includes(entry.id));
  const text = edited ?? draft.body;
  const changed = edited === null ? null : Math.round(changedFraction(draft.body, edited) * 100);
  const busy = reply.isPending || approveOpen || rejectOpen;

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

  const confirm = () => {
    onApproveOpenChange(false);
    if (reply.isPending || isDraftPending(draft.id)) {
      toast(t('ai.draft.alreadySending'));
      return;
    }
    const body = text.trim();
    // Exactly the draft: the server records this person as its approver (N3, ADR-011). Any change:
    // the person's own text, and the server records the draft as edited with the distance.
    const unchanged = body === draft.body.trim();
    reply.mutate(
      {
        body,
        ...(unchanged ? { aiDraftId: draft.id } : { editedFromDraftId: draft.id }),
        // On an email ticket the approved text goes out as a real email: HTML with the text copy.
        ...('channel' in ticket && ticket.channel === 'gmail'
          ? { email: { cc: [], bcc: [], inline: [], bodyHtml: textToHtml(body) } }
          : {}),
      },
      {
        onSuccess: (result) => {
          // The server holds the reply for its undo window; Undo cancels it there.
          offer(result.message, unchanged ? draft.id : null);
          actions.sent(draft.id);
        },
        onError: () => {
          toast(t('ai.draft.sendFailed'));
          // A draft that was replaced or already used must not stay on screen.
          actions.refresh();
        },
      },
    );
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
      className="mx-4 mt-2.5 flex shrink-0 flex-col gap-2.5 rounded-lg bg-surface px-5 py-4 ring-1 ring-border/70 ring-inset"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span
          aria-hidden
          className="inline-flex size-6 items-center justify-center rounded-full bg-tint-teal-bg text-tint-teal-icon"
        >
          <PenLine className="size-3.5" />
        </span>
        <h4 id={headingId} className="text-sm font-medium text-foreground">
          {t('ai.draft.label')}
        </h4>
        {changed !== null ? (
          <TintChip tone="slate" icon={Pencil}>
            {t('ai.draft.edited', { percent: changed })}
          </TintChip>
        ) : null}
        {draft.uncitedClaims > 0 ? (
          <TintChip tone="amber" icon={TriangleAlert} title={t('ai.brief.uncitedTip')}>
            {t('ai.brief.uncited', { count: draft.uncitedClaims })}
          </TintChip>
        ) : null}
        {draft.disclosure?.level === 'restricted' ? (
          <TintChip
            tone="amber"
            icon={ShieldAlert}
            title={t('ai.draft.restrictedTip', { count: draft.disclosure.removedSentences })}
          >
            {t('ai.draft.restricted')}
          </TintChip>
        ) : null}
        {draft.needsReview ? (
          <TintChip tone="amber" icon={TriangleAlert} title={t('ai.draft.needsReviewTip')}>
            {t('ai.draft.needsReview')}
          </TintChip>
        ) : null}
        {draft.language ? (
          <TintChip tone="slate" icon={Languages}>
            {t('ai.draft.language', { language: draft.language.toUpperCase() })}
          </TintChip>
        ) : null}
      </header>

      {/* Before the text, not after it: on a phone the sticky action bar below covers whatever is
          at the foot of a long draft, and a control must never sit half under it. */}
      {cited.length > 0 ? (
        <ul aria-label={t('ai.draft.sources')} className="flex flex-wrap gap-1.5">
          {cited.map((entry) => {
            const Icon = EVIDENCE_ICONS[entry.kind];
            return (
              <li key={entry.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => {
                    onOpenEvidence(entry.id);
                  }}
                  className="inline-flex h-7 max-w-[16rem] items-center gap-1.5 rounded-full bg-ai-subtle px-2.5 text-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                >
                  <Icon aria-hidden className="size-3.5 shrink-0 text-ai-accent" />
                  <span className="sr-only">{t(`ai.evidence.kinds.${entry.kind}`)}:</span>
                  <span className="truncate">{entry.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
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
          'max-md:sticky max-md:bottom-0 max-md:-mx-5 max-md:-mb-4 max-md:rounded-b-lg max-md:border-t max-md:border-border/60 max-md:bg-surface max-md:px-5 max-md:py-2.5',
        )}
      >
        {editing ? (
          <>
            <Button
              variant="primary"
              className="rounded-full max-md:min-h-[44px]"
              onClick={() => {
                setEditing(false);
              }}
            >
              <Check aria-hidden className="size-4" />
              {t('ai.draft.done')}
            </Button>
            <IconButton
              variant="secondary"
              className="max-md:min-h-[44px]"
              label={t('ai.draft.revert')}
              icon={<RotateCcw aria-hidden className="size-4" />}
              onClick={() => {
                setEdited(null);
                setEditing(false);
              }}
            />
          </>
        ) : (
          <>
            <Tooltip content={t('ai.draft.approve')} shortcut={singleKeyShortcuts ? ['A'] : []}>
              <Button
                variant="primary"
                aria-keyshortcuts="A"
                className="rounded-full px-4 max-md:min-h-[44px] max-md:min-w-[44px] max-md:flex-1"
                disabled={busy}
                onClick={startApprove}
              >
                <Check aria-hidden className="size-4" />
                {t('ai.draft.approve')}
              </Button>
            </Tooltip>
            <Tooltip content={t('ai.draft.edit')} shortcut={singleKeyShortcuts ? ['E'] : []}>
              <Button
                variant="secondary"
                aria-keyshortcuts="E"
                className="rounded-full max-md:min-h-[44px] max-md:min-w-[44px] max-md:flex-1"
                disabled={busy}
                onClick={startEdit}
              >
                <Pencil aria-hidden className="size-4" />
                {t('ai.draft.edit')}
              </Button>
            </Tooltip>
            <Tooltip content={t('ai.draft.reject')} shortcut={singleKeyShortcuts ? ['R'] : []}>
              <Button
                variant="secondary"
                aria-keyshortcuts="R"
                className="rounded-full max-md:min-h-[44px] max-md:min-w-[44px] max-md:flex-1"
                disabled={busy}
                onClick={startReject}
              >
                <X aria-hidden className="size-4" />
                {t('ai.draft.reject')}
              </Button>
            </Tooltip>
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
