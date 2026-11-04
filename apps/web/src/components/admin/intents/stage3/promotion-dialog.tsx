'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { GateReport, Promotion } from '@watchtower/shared';
import {
  Button,
  buttonVariants,
  Dialog,
  DialogContent,
  Input,
  Textarea,
  toast,
} from '@watchtower/ui';
import { CircleX, ShieldAlert } from 'lucide-react';
import { useId, useState } from 'react';

import { useI18n } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { adminKeys, stage3Keys } from '@/lib/admin/queries';
import { approveReturnPath, refusedReasonKey } from '@/lib/admin/stage3';
import { useApi } from '@/lib/api/api-context';
import { isApiError } from '@/lib/api/errors';
import { SSO_PROVIDER, stepUpUrl } from '@/lib/auth/providers';
import { useUserId } from '@/lib/auth/session';
import { useRuntimeConfig } from '@/lib/runtime-config-context';

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
 * When the api answers `reauth_required` the dialog says a fresh sign-in is needed and links to the api
 * step-up route; the return address brings them back to this dialog (`?approve=<id>`) to press Approve again.
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
  const { apiUrl } = useRuntimeConfig();
  const queryClient = useQueryClient();
  const baseId = useId();
  const [reason, setReason] = useState('');
  const [typedKey, setTypedKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needsStepUp, setNeedsStepUp] = useState(false);

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
        // Say a fresh sign-in is needed and offer the way (a link to the api step-up route that comes back to
        // this dialog). The write is never repeated by itself: the person presses Approve again.
        setNeedsStepUp(true);
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
      if (isApiError(failure) && failure.status === 403) {
        const key = refusedReasonKey(failure.details);
        if (key !== null) {
          setError(t(key));
          return;
        }
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
  const busy = run.isPending;
  const stepUpHref = approving
    ? stepUpUrl(apiUrl, approveReturnPath(intentId, mode.promotion.id))
    : null;

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
            {needsStepUp && stepUpHref !== null ? (
              <a href={stepUpHref} className={buttonVariants({ variant: 'primary' })}>
                {t('stage3.promo.reauthAction')}
              </a>
            ) : (
              <Button
                variant="primary"
                type="submit"
                form={formId}
                disabled={busy || !reasonOk || !keyOk}
              >
                {run.isPending ? copy.pending : copy.submit}
              </Button>
            )}
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
          {approving && !needsStepUp ? (
            <p className="text-sm text-muted-foreground">{t('stage3.promo.reauth')}</p>
          ) : null}
          {needsStepUp ? (
            <p role="alert" className="flex items-start gap-1.5 text-sm font-medium">
              <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>{t('stage3.promo.reauthNeeded', { provider: SSO_PROVIDER.displayName })}</span>
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
