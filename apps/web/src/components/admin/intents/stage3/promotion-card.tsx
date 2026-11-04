'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AutonomyPromotionState, GateReport, Promotion } from '@watchtower/shared';
import { Button, TintChip, toast } from '@watchtower/ui';
import { CircleCheck, CircleX, Clock, Info, UserCheck } from 'lucide-react';
import { useId, useState } from 'react';

import { RelativeTime } from '@/components/relative-time';
import { useI18n } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { adminKeys, stage3Keys } from '@/lib/admin/queries';
import { PROMOTION_BLOCK_KEYS, type PromotionBlock } from '@/lib/admin/stage3';
import { useApi } from '@/lib/api/api-context';
import { isApiError } from '@/lib/api/errors';
import { useUserId } from '@/lib/auth/session';

import { PromotionDialog, type PromotionDialogMode } from './promotion-dialog';

const STATUS_ICON = {
  requested: Clock,
  approved: UserCheck,
  rejected: CircleX,
  applied: CircleCheck,
  expired: Clock,
  cancelled: CircleX,
} as const;

/**
 * The way to Stage 3 (ADR-025 section 6): ask, approve, apply. The button to ask is off while something stands in
 * the way and the reason is written next to it, not only in a tooltip. The owner approves in a dialog that
 * asks for the key of the intent; a request the owner made and approved themselves is marked.
 */
export function PromotionCard({
  intentId,
  intentKey,
  intentName,
  block,
  autosendFlag,
  latestReport,
  openPromotion,
  history,
  canRequest,
  canApprove,
  currentUserId,
  approveId,
  onApproveHandled,
}: {
  intentId: string;
  intentKey: string;
  intentName: string;
  block: PromotionBlock | null;
  autosendFlag: boolean;
  latestReport: GateReport | null;
  openPromotion: AutonomyPromotionState['openPromotion'];
  history: Promotion[];
  /** `ai.autonomy.promote`: the head. */
  canRequest: boolean;
  /** `ai.autonomy.owner_approve`: the owner. */
  canApprove: boolean;
  currentUserId: string;
  /** From the return address after a fresh sign-in: open this request's approval dialog. */
  approveId: string | null;
  onApproveHandled: () => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const reasonId = useId();
  const [dialog, setDialog] = useState<PromotionDialogMode | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Back from sign-in: the request to approve is open again, so the dialog opens again.
  const returning =
    dialog === null &&
    canApprove &&
    approveId !== null &&
    openPromotion?.id === approveId &&
    openPromotion.status === 'requested';
  const shown: PromotionDialogMode | null =
    dialog ?? (returning ? { kind: 'approve', promotion: openPromotion } : null);

  const close = () => {
    setDialog(null);
    if (approveId !== null) onApproveHandled();
  };

  const apply = useMutation({
    mutationFn: (promotionId: string) => api.applyPromotion(promotionId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: stage3Keys(userId, intentId) });
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).autonomy });
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).intentHistory(intentId) });
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).auditAll });
      setApplyError(null);
      toast(t(result.status === 'applied' ? 'stage3.promo.applied' : 'stage3.promo.expiredNow'));
    },
    onError: (failure) => {
      setApplyError(
        isApiError(failure) && failure.code === 'autosend_flag_off'
          ? t('stage3.promo.flagOff')
          : describeError(failure, t).message,
      );
    },
  });

  const askOff = block !== null;
  const mine = openPromotion?.requestedBy === currentUserId;

  return (
    <section aria-labelledby="stage3-promo" className="flex max-w-2xl flex-col gap-3">
      <div>
        <h2 id="stage3-promo" className="text-base font-semibold">
          {t('stage3.promo.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('stage3.promo.lead')}</p>
      </div>

      {block !== null && block !== 'request_open' ? (
        <div
          id={reasonId}
          role="note"
          data-block={block}
          className="flex items-start gap-2 rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm"
        >
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">{t('stage3.block.title')}</p>
            <p>{t(PROMOTION_BLOCK_KEYS[block])}</p>
          </div>
        </div>
      ) : null}

      {canRequest ? (
        <div className="flex flex-col items-start gap-1">
          <Button
            variant="primary"
            disabled={askOff}
            aria-describedby={askOff ? reasonId : undefined}
            onClick={() => {
              if (latestReport) setDialog({ kind: 'request', report: latestReport });
            }}
          >
            {t('stage3.promo.ask')}
          </Button>
          {block === 'request_open' ? (
            <p id={reasonId} className="text-sm text-muted-foreground">
              {t(PROMOTION_BLOCK_KEYS.request_open)}
            </p>
          ) : null}
        </div>
      ) : null}

      {openPromotion ? (
        <PromotionRow
          promotion={openPromotion}
          open
          actions={
            <>
              {openPromotion.status === 'requested' && canApprove ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    setDialog({ kind: 'approve', promotion: openPromotion });
                  }}
                >
                  {t('stage3.promo.approve')}
                </Button>
              ) : null}
              {openPromotion.status === 'requested' && (canApprove || canRequest) ? (
                <Button
                  onClick={() => {
                    setDialog({ kind: 'reject', promotion: openPromotion });
                  }}
                >
                  {t('stage3.promo.reject')}
                </Button>
              ) : null}
              {openPromotion.status === 'requested' && mine ? (
                <Button
                  onClick={() => {
                    setDialog({ kind: 'withdraw', promotion: openPromotion });
                  }}
                >
                  {t('stage3.promo.withdraw')}
                </Button>
              ) : null}
              {openPromotion.status === 'approved' && canApprove ? (
                <Button
                  variant="primary"
                  disabled={apply.isPending || !autosendFlag}
                  onClick={() => {
                    setApplyError(null);
                    apply.mutate(openPromotion.id);
                  }}
                >
                  {apply.isPending ? t('stage3.promo.applying') : t('stage3.promo.apply')}
                </Button>
              ) : null}
              {openPromotion.status === 'approved' && canApprove && !autosendFlag ? (
                <p className="basis-full text-sm text-muted-foreground">
                  {t('stage3.promo.flagOff')}
                </p>
              ) : null}
              {openPromotion.status === 'requested' && !canApprove ? (
                <p className="basis-full text-sm text-muted-foreground">
                  {t('stage3.promo.ownerWaiting')}
                </p>
              ) : null}
            </>
          }
        />
      ) : null}
      {applyError ? (
        <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-danger">
          <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{applyError}</span>
        </p>
      ) : null}

      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">{t('stage3.promo.history')}</h3>
        {history.filter((item) => item.id !== openPromotion?.id).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('stage3.promo.none')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {history
              .filter((item) => item.id !== openPromotion?.id)
              .map((item) => (
                <li key={item.id} className="py-2">
                  <PromotionRow promotion={item} />
                </li>
              ))}
          </ul>
        )}
      </div>

      {shown ? (
        <PromotionDialog
          key={`${shown.kind}-${'promotion' in shown ? shown.promotion.id : shown.report.id}`}
          intentId={intentId}
          intentKey={intentKey}
          intentName={intentName}
          mode={shown}
          onClose={close}
        />
      ) : null}
    </section>
  );
}

function PromotionRow({
  promotion,
  open = false,
  actions,
}: {
  promotion: Promotion;
  open?: boolean;
  actions?: React.ReactNode;
}) {
  const { t } = useI18n();
  const Icon = STATUS_ICON[promotion.status];
  const tone =
    promotion.status === 'applied'
      ? 'green'
      : promotion.status === 'approved'
        ? 'teal'
        : promotion.status === 'requested'
          ? 'amber'
          : 'slate';
  return (
    <div
      data-promotion={promotion.id}
      data-status={promotion.status}
      className={
        open
          ? 'flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2 text-sm'
          : 'flex flex-col gap-1 text-sm'
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <TintChip tone={tone} icon={Icon} strong={open}>
          {t(`stage3.promo.status.${promotion.status}`)}
        </TintChip>
        {promotion.selfApproved ? (
          <span
            title={t('stage3.promo.selfApprovedHint')}
            className="inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-xs font-medium"
          >
            <UserCheck aria-hidden className="size-3.5" />
            {t('stage3.promo.selfApproved')}
          </span>
        ) : null}
      </div>
      <p className="text-muted-foreground">
        {t('stage3.promo.by', {
          name: promotion.requestedByName ?? t('stage3.promo.byUnknown'),
          time: '',
        })}
        <RelativeTime iso={promotion.requestedAt} />
      </p>
      <p>{t('stage3.promo.reasonQuote', { reason: promotion.requestReason })}</p>
      {promotion.decidedAt ? (
        <p className="text-muted-foreground">
          {t('stage3.promo.decidedBy', {
            name: promotion.decidedByName ?? t('stage3.promo.byUnknown'),
            time: '',
          })}
          <RelativeTime iso={promotion.decidedAt} />
          {promotion.decisionReason
            ? ` · ${t('stage3.promo.reasonQuote', { reason: promotion.decisionReason })}`
            : ''}
        </p>
      ) : null}
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
