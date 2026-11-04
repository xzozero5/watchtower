'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { GateReport, Promotion } from '@watchtower/shared';
import { Button, Dialog, DialogContent, Input, Textarea, toast } from '@watchtower/ui';
import { CircleX } from 'lucide-react';
import { useId, useState } from 'react';

import { useI18n } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { adminKeys, stage3Keys } from '@/lib/admin/queries';
import { approveReturnPath } from '@/lib/admin/stage3';
import { useApi } from '@/lib/api/api-context';
import { isApiError } from '@/lib/api/errors';
import { useSession, useUserId } from '@/lib/auth/session';

const REASON_MIN = 3;
const REASON_MAX = 500;

export type PromotionDialogMode =
  | { kind: 'request'; report: GateReport }
  | { kind: 'approve'; promotion: Promotion }
  | { kind: 'reject'; promotion: Promotion }
  | { kind: 'withdraw'; promotion: Promotion };

/**
 * The four steps of a promotion that need words: the head asks, the owner approves (typing the key of the
 * intent, after a fresh sign-in), the owner or a head rejects, the requester withdraws (ADR-025 section 6).
 * When the api answers `reauth_required` the dialog says so and sends the person through sign-in; the
 * return address brings them back to this same dialog (`?approve=<id>`).
 */
export function PromotionDialog({
  intentId,
  intentKey,
  intentName,
  mode,
  onClose,
}: {
  intentId: string;
  intentKey: string;
  intentName: string;
  mode: PromotionDialogMode;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const { signOut } = useSession();
  const queryClient = useQueryClient();
  const baseId = useId();
  const [reason, setReason] = useState('');
  const [typedKey, setTypedKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reauthing, setReauthing] = useState(false);

  const approving = mode.kind === 'approve';
  const reasonOk = reason.trim().length >= REASON_MIN && reason.trim().length <= REASON_MAX;
  const keyOk = !approving || typedKey.trim() === intentKey;
  const keyWrong = approving && typedKey !== '' && typedKey.trim() !== intentKey;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: stage3Keys(userId, intentId) });
    void queryClient.invalidateQueries({ queryKey: adminKeys(userId).autonomy });
    void queryClient.invalidateQueries({ queryKey: adminKeys(userId).intentHistory(intentId) });
    void queryClient.invalidateQueries({ queryKey: adminKeys(userId).auditAll });
  };

  const run = useMutation({
    mutationFn: async () => {
      const text = reason.trim();
      switch (mode.kind) {
        case 'request':
          return api.requestPromotion(intentId, { gateReportId: mode.report.id, reason: text });
        case 'approve':
          return api.decidePromotion(mode.promotion.id, {
            approve: true,
            reason: text,
            confirmKey: typedKey.trim(),
          });
        case 'reject':
        case 'withdraw':
          return api.decidePromotion(mode.promotion.id, { approve: false, reason: text });
      }
    },
    onSuccess: () => {
      refresh();
      toast(
        t(
          mode.kind === 'request'
            ? 'stage3.promo.sent'
            : mode.kind === 'approve'
              ? 'stage3.promo.approved'
              : mode.kind === 'reject'
                ? 'stage3.promo.rejected'
                : 'stage3.promo.withdrawn',
        ),
      );
      onClose();
    },
    onError: (failure) => {
      if (isApiError(failure) && failure.code === 'reauth_required' && mode.kind === 'approve') {
        // Put the way back into the address, then end this session: the auth gate sends the person to
        // sign in with this address as the destination, and the page opens this dialog again.
        setReauthing(true);
        window.history.replaceState(null, '', approveReturnPath(intentId, mode.promotion.id));
        void signOut();
        return;
      }
      if (isApiError(failure) && failure.code === 'owner_only') {
        setError(t('stage3.promo.ownerOnly'));
        return;
      }
      if (isApiError(failure) && failure.code === 'autosend_flag_off') {
        setError(t('stage3.promo.flagOff'));
        return;
      }
      setError(describeError(failure, t).message);
    },
  });

  const copy = {
    request: {
      title: t('stage3.promo.askTitle'),
      body: t('stage3.promo.askBody'),
      label: t('stage3.promo.askReason'),
      submit: t('stage3.promo.send'),
      pending: t('stage3.promo.sending'),
    },
    approve: {
      title: t('stage3.promo.approveTitle', { name: intentName }),
      body: t('stage3.promo.approveBody'),
      label: t('stage3.promo.approveReason'),
      submit: t('stage3.promo.approveSubmit'),
      pending: t('stage3.promo.approving'),
    },
    reject: {
      title: t('stage3.promo.rejectTitle'),
      body: t('stage3.promo.rejectBody'),
      label: t('stage3.promo.approveReason'),
      submit: t('stage3.promo.rejectSubmit'),
      pending: t('stage3.promo.sending'),
    },
    withdraw: {
      title: t('stage3.promo.withdrawTitle'),
      body: t('stage3.promo.withdrawBody'),
      label: t('stage3.promo.approveReason'),
      submit: t('stage3.promo.withdrawSubmit'),
      pending: t('stage3.promo.sending'),
    },
  }[mode.kind];

  const formId = `${baseId}-form`;
  const reasonId = `${baseId}-reason`;
  const keyId = `${baseId}-key`;
  const busy = run.isPending || reauthing;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        title={copy.title}
        description={copy.body}
        closeLabel={t('admin.common.close')}
        footer={
          <>
            <Button onClick={onClose} disabled={busy}>
              {t('admin.common.cancel')}
            </Button>
            <Button
              variant="primary"
              type="submit"
              form={formId}
              disabled={busy || !reasonOk || !keyOk}
            >
              {run.isPending ? copy.pending : copy.submit}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (reasonOk && keyOk && !busy) {
              setError(null);
              run.mutate();
            }
          }}
          className="flex flex-col gap-3"
        >
          {approving ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={keyId} className="text-sm font-medium">
                {t('stage3.promo.typeKey', { key: intentKey })}
              </label>
              <Input
                id={keyId}
                value={typedKey}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={keyWrong ? true : undefined}
                aria-describedby={keyWrong ? `${keyId}-error` : undefined}
                onChange={(event) => {
                  setTypedKey(event.target.value);
                }}
                className="font-mono"
              />
              {keyWrong ? (
                <p
                  id={`${keyId}-error`}
                  className="flex items-start gap-1 text-sm font-medium text-danger"
                >
                  <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <span>{t('stage3.promo.keyMismatch')}</span>
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <label htmlFor={reasonId} className="text-sm font-medium">
              {copy.label}
            </label>
            <Textarea
              id={reasonId}
              rows={3}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              className="w-full resize-y"
            />
          </div>
          {approving ? (
            <p className="text-sm text-muted-foreground">{t('stage3.promo.reauth')}</p>
          ) : null}
          {reauthing ? (
            <p role="status" className="text-sm font-medium">
              {t('stage3.promo.reauthRedirect')}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-danger">
              <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
