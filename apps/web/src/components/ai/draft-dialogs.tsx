'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { AI_REJECT_REASONS, type AiRejectReason } from '@watchtower/shared';
import { Alert, Button, Kbd, Textarea } from '@watchtower/ui';
import { TriangleAlert } from 'lucide-react';
import { type KeyboardEvent, useId, useRef, useState } from 'react';

import { useT } from '@/i18n/provider';

const OVERLAY = 'fixed inset-0 z-40 animate-fade-in bg-scrim';
const CONTENT =
  'fixed top-[10vh] left-1/2 z-50 flex max-h-[80vh] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-surface p-4 text-foreground shadow-overlay';

/**
 * "Approve" never sends blind: this preview shows the exact text and who gets it, flags uncited
 * claims, and only its confirm button starts the send (the undo window follows). Focus lands on
 * the confirm button, so A then Enter is the fast path and Esc backs out.
 */
export function ApproveDialog({
  open,
  onOpenChange,
  body,
  recipient,
  channel,
  uncited,
  changedPercent,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  body: string;
  recipient: string | null;
  channel: string;
  uncited: number;
  /** Set when the person edited the draft: how much of it changed. */
  changedPercent: number | null;
  onConfirm: () => void;
}) {
  const t = useT();
  const confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content
          className={CONTENT}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            confirmRef.current?.focus();
          }}
        >
          <Dialog.Title className="text-base font-semibold">{t('ai.approve.title')}</Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground">
            {recipient
              ? t('ai.approve.to', { name: recipient, channel })
              : t('ai.approve.toUnknown', { channel })}
          </Dialog.Description>
          <blockquote
            aria-label={t('ai.approve.preview')}
            className="max-h-[40vh] overflow-y-auto rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm break-words whitespace-pre-wrap"
          >
            {body}
          </blockquote>
          {uncited > 0 ? (
            <p
              role="status"
              className="flex items-center gap-2 rounded-lg border border-border-strong px-3 py-2 text-sm font-medium"
            >
              <TriangleAlert aria-hidden className="size-4 shrink-0" />
              {t('ai.approve.uncited', { count: uncited })}
            </p>
          ) : null}
          {changedPercent !== null ? (
            <p className="text-xs text-muted-foreground">
              {t('ai.approve.edited', { percent: changedPercent })}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="secondary">{t('ai.approve.cancel')}</Button>
            </Dialog.Close>
            <Button ref={confirmRef} variant="primary" onClick={onConfirm}>
              {t('ai.approve.confirm')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Why a draft is rejected (docs/06-UI-SPEC.md section 6.3): one required reason, the digits 1 to 9
 * pick one, and a comment that is required for "Other". Nothing is sent until Reject is pressed;
 * a failed call keeps the dialog open with the reason still chosen.
 */
export function RejectDialog({
  open,
  onOpenChange,
  onSubmit,
  pending,
  failed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: AiRejectReason, comment: string) => void;
  pending: boolean;
  failed: boolean;
}) {
  const t = useT();
  const ids = useId();
  const [reason, setReason] = useState<AiRejectReason | null>(null);
  const [comment, setComment] = useState('');

  const needsComment = reason === 'other';
  const ready = reason !== null && (!needsComment || comment.trim() !== '') && !pending;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target instanceof HTMLTextAreaElement) return;
    const index = Number(event.key) - 1;
    const picked = Number.isInteger(index) ? AI_REJECT_REASONS[index] : undefined;
    if (picked) {
      event.preventDefault();
      setReason(picked);
    }
  };

  const submit = () => {
    if (reason && ready) onSubmit(reason, comment.trim());
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setReason(null);
          setComment('');
        }
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content className={CONTENT} onKeyDown={onKeyDown}>
          <Dialog.Title className="text-base font-semibold">{t('ai.reject.title')}</Dialog.Title>
          <Dialog.Description className="sr-only">{t('ai.reject.reason')}</Dialog.Description>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            className="flex flex-col gap-3"
          >
            <fieldset className="flex flex-col gap-0.5">
              <legend className="mb-1 text-sm text-muted-foreground">
                {t('ai.reject.reason')}
              </legend>
              {AI_REJECT_REASONS.map((code, index) => (
                <label
                  key={code}
                  className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-1 text-sm hover:bg-surface-muted"
                >
                  <input
                    type="radio"
                    name={`${ids}-reason`}
                    value={code}
                    checked={reason === code}
                    onChange={() => {
                      setReason(code);
                    }}
                    className="size-4 shrink-0 accent-primary"
                  />
                  <span className="flex-1">{t(`ai.reject.reasons.${code}`)}</span>
                  <Kbd>{index + 1}</Kbd>
                </label>
              ))}
            </fieldset>

            <div className="flex flex-col gap-1">
              <label htmlFor={`${ids}-comment`} className="text-sm text-muted-foreground">
                {t('ai.reject.comment')}
              </label>
              <Textarea
                id={`${ids}-comment`}
                rows={2}
                value={comment}
                aria-required={needsComment}
                aria-invalid={needsComment && comment.trim() === '' ? true : undefined}
                onChange={(event) => {
                  setComment(event.target.value);
                }}
              />
              {needsComment && comment.trim() === '' ? (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <TriangleAlert aria-hidden className="size-3.5" />
                  {t('ai.reject.commentRequired')}
                </p>
              ) : null}
            </div>

            {failed ? <Alert tone="error" title={t('ai.reject.error')} /> : null}

            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button type="button" variant="secondary">
                  {t('ai.reject.cancel')}
                </Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={!ready}>
                {t('ai.reject.submit')}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
