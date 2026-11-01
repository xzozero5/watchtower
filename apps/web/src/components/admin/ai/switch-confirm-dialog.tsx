'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AiSwitchKey } from '@watchtower/shared';
import { Button, Dialog, DialogContent, Textarea, toast } from '@watchtower/ui';
import { CircleX } from 'lucide-react';
import { type KeyboardEvent, useId, useRef, useState } from 'react';

import type { MessageKey } from '@/i18n';
import { useT } from '@/i18n/provider';
import { adminKeys } from '@/lib/admin/queries';
import { describeError } from '@/lib/admin/errors';
import { isApiError } from '@/lib/api/errors';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';

export const REASON_MIN = 3;
export const REASON_MAX = 500;

export interface SwitchTarget {
  switchKey: AiSwitchKey;
  /** The value the switch would get. */
  on: boolean;
}

type Variant = 'stop' | 'resume' | 'limit' | 'unlimit';

function variantOf({ switchKey, on }: SwitchTarget): Variant {
  if (switchKey === 'ai_kill_switch') return on ? 'stop' : 'resume';
  return on ? 'limit' : 'unlimit';
}

const COPY: Record<
  Variant,
  { title: MessageKey; body: MessageKey; extra: MessageKey; verb: MessageKey; state: MessageKey }
> = {
  stop: {
    title: 'admin.ai.dialog.stopTitle',
    body: 'admin.ai.dialog.stopBody',
    extra: 'admin.ai.dialog.stopExtra',
    verb: 'admin.ai.confirm.stop',
    state: 'admin.ai.state.killOn',
  },
  resume: {
    title: 'admin.ai.dialog.resumeTitle',
    body: 'admin.ai.dialog.resumeBody',
    extra: 'admin.ai.dialog.resumeExtra',
    verb: 'admin.ai.confirm.resume',
    state: 'admin.ai.state.killOff',
  },
  limit: {
    title: 'admin.ai.dialog.limitTitle',
    body: 'admin.ai.dialog.limitBody',
    extra: 'admin.ai.dialog.limitExtra',
    verb: 'admin.ai.confirm.limit',
    state: 'admin.ai.state.capOn',
  },
  unlimit: {
    title: 'admin.ai.dialog.unlimitTitle',
    body: 'admin.ai.dialog.unlimitBody',
    extra: 'admin.ai.dialog.unlimitExtra',
    verb: 'admin.ai.confirm.unlimit',
    state: 'admin.ai.state.capOff',
  },
};

/**
 * The confirm dialog for the two AI switches, in both directions (po decision 23, docs/06-UI-SPEC.md
 * section 18.4). A reason of 3 to 500 characters is required, there is no typed confirmation,
 * Ctrl or Cmd + Enter submits and Esc cancels. The page buttons and the command palette only open
 * this dialog; nothing else flips a switch.
 */
export function SwitchConfirmDialog({
  target,
  onClose,
}: {
  target: SwitchTarget | null;
  onClose: () => void;
}) {
  return (
    <>
      {target ? (
        <SwitchConfirmBody
          key={`${target.switchKey}:${String(target.on)}`}
          target={target}
          onClose={onClose}
        />
      ) : null}
    </>
  );
}

function SwitchConfirmBody({ target, onClose }: { target: SwitchTarget; onClose: () => void }) {
  const t = useT();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const reasonId = useId();
  const formId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const copy = COPY[variantOf(target)];
  const length = reason.trim().length;
  const valid = length >= REASON_MIN && length <= REASON_MAX;

  const flip = useMutation({
    mutationFn: () =>
      api.setAiSwitch({ switch: target.switchKey, on: target.on, reason: reason.trim() }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).autonomy });
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).auditAll });
      toast(
        result.changed
          ? t('admin.ai.changedToast', { title: t(copy.verb) })
          : t('admin.ai.noChange', { state: t(copy.state) }),
      );
      onClose();
    },
    onError: (error) => {
      if (isApiError(error) && error.status === 400) {
        setReasonError(t('admin.ai.reasonInvalid', { min: REASON_MIN, max: REASON_MAX }));
        field.current?.focus();
        return;
      }
      setDialogError(describeError(error, t).message);
    },
  });

  const submit = () => {
    setDialogError(null);
    if (!valid) {
      setReasonError(t('admin.ai.reasonInvalid', { min: REASON_MIN, max: REASON_MAX }));
      field.current?.focus();
      return;
    }
    setReasonError(null);
    flip.mutate();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !flip.isPending) onClose();
      }}
    >
      <DialogContent
        title={t(copy.title)}
        description={t(copy.body)}
        closeLabel={t('admin.common.close')}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          field.current?.focus();
        }}
        onKeyDown={onKeyDown}
        footer={
          <>
            <Button onClick={onClose} disabled={flip.isPending}>
              {t('admin.common.cancel')}
            </Button>
            <Button variant="primary" type="submit" form={formId} disabled={flip.isPending}>
              {flip.isPending ? t('admin.form.saving') : t(copy.verb)}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-sm text-muted-foreground">{t(copy.extra)}</p>
          <div className="flex flex-col gap-1">
            <label htmlFor={reasonId} className="text-sm font-medium">
              {t('admin.ai.reasonLabel', { min: REASON_MIN, max: REASON_MAX })}
            </label>
            <Textarea
              id={reasonId}
              ref={field}
              rows={3}
              value={reason}
              maxLength={REASON_MAX + 100}
              aria-invalid={reasonError ? true : undefined}
              aria-describedby={
                reasonError ? `${reasonId}-error ${reasonId}-count` : `${reasonId}-count`
              }
              onChange={(event) => {
                setReason(event.target.value);
                if (reasonError) setReasonError(null);
              }}
              className="w-full resize-y"
            />
            <div className="flex items-start justify-between gap-3">
              {reasonError ? (
                <p
                  id={`${reasonId}-error`}
                  className="flex items-start gap-1 text-sm font-medium text-danger"
                >
                  <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <span>{reasonError}</span>
                </p>
              ) : (
                <span />
              )}
              <span
                id={`${reasonId}-count`}
                className="tabular shrink-0 text-xs text-muted-foreground"
              >
                {t('admin.ai.reasonCount', { count: length, max: REASON_MAX })}
              </span>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">{t('admin.ai.auditNote')}</p>
          {dialogError ? (
            <p role="alert" className="flex items-start gap-1 text-sm font-medium text-danger">
              <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>{dialogError}</span>
            </p>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
