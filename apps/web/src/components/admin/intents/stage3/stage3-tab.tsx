'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AutonomyIntent } from '@watchtower/shared';
import { Skeleton, TintChip, toast } from '@watchtower/ui';
import { CircleCheck, CircleX } from 'lucide-react';

import { LoadError } from '@/components/admin/admin-page';
import { useI18n } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import {
  adminKeys,
  stage3Keys,
  useGateReports,
  usePromotions,
  usePromotionState,
} from '@/lib/admin/queries';
import { promotionBlock } from '@/lib/admin/stage3';
import { useApi } from '@/lib/api/api-context';
import { useSession, useUserId } from '@/lib/auth/session';

import { AutosendSettings } from './autosend-settings';
import { GateReportCard, ShadowCard } from './gate-report-card';
import { PromotionCard } from './promotion-card';
import { useState } from 'react';

/**
 * The "Stage 3" tab of an intent (T-304g, ADR-025): where the instance stands (is auto-send on at all), the
 * gate report, the shadow results, the auto-send settings and the road to Stage 3. Reading is for anyone who
 * manages intents; acting is by permission (the head asks and changes settings, the owner approves).
 */
export function Stage3Tab({
  intent,
  autosendFlag,
  approveId,
  onApproveHandled,
}: {
  intent: AutonomyIntent;
  autosendFlag: boolean;
  approveId: string | null;
  onApproveHandled: () => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const { can, session } = useSession();
  const queryClient = useQueryClient();
  const [makeError, setMakeError] = useState<string | null>(null);

  const state = usePromotionState(intent.id, true);
  const reports = useGateReports(intent.id, true);
  const promotions = usePromotions(intent.id, true);

  const make = useMutation({
    mutationFn: () => api.createGateReport(intent.id),
    onSuccess: () => {
      setMakeError(null);
      void queryClient.invalidateQueries({ queryKey: stage3Keys(userId, intent.id) });
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).auditAll });
      toast(t('stage3.report.generated'));
    },
    onError: (failure) => {
      setMakeError(`${t('stage3.report.generateFailed')} ${describeError(failure, t).message}`);
    },
  });

  if (state.isPending || reports.isPending || promotions.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex max-w-2xl flex-col gap-3">
        <span className="sr-only">{t('admin.common.loading')}</span>
        <Skeleton className="h-8" />
        <Skeleton className="h-32" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (state.isError || reports.isError || promotions.isError) {
    return (
      <LoadError
        message={t('stage3.loadError')}
        onRetry={() => {
          void state.refetch();
          void reports.refetch();
          void promotions.refetch();
        }}
      />
    );
  }

  // The newest report the list knows is the one to read; the door's own `latestReport` is what the api checks.
  const latestReport = state.data.latestReport ?? reports.data.items[0] ?? null;
  const block = promotionBlock({
    autosendFlag,
    stage: intent.stage,
    pinned: intent.pinned,
    latestReport,
    openPromotion: state.data.openPromotion,
  });
  const canRequest = can('ai.autonomy.promote');
  const canApprove = can('ai.autonomy.owner_approve');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold">{t('stage3.title')}</h2>
        <p className="max-w-prose text-sm text-muted-foreground">{t('stage3.lead')}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <TintChip
            tone={autosendFlag ? 'green' : 'slate'}
            icon={autosendFlag ? CircleCheck : CircleX}
            strong={autosendFlag}
          >
            {t(autosendFlag ? 'stage3.state.flagOn' : 'stage3.state.flagOff')}
          </TintChip>
          <span className="text-sm text-muted-foreground">
            {t('stage3.state.effective', { stage: intent.effectiveStage })}
          </span>
        </div>
        {!canRequest && !canApprove ? (
          <p className="mt-1 text-sm text-muted-foreground">{t('stage3.noPermission')}</p>
        ) : null}
      </div>

      <GateReportCard
        report={latestReport}
        canMake={canRequest}
        making={make.isPending}
        makeError={makeError}
        onMake={() => {
          setMakeError(null);
          make.mutate();
        }}
      />
      <ShadowCard report={latestReport} />
      <AutosendSettings
        key={JSON.stringify(intent.autosend ?? null)}
        intent={intent}
        canChange={can('ai.autonomy.set.any')}
      />
      <PromotionCard
        intentId={intent.id}
        intentKey={intent.key}
        intentName={intent.name}
        block={block}
        autosendFlag={autosendFlag}
        latestReport={latestReport}
        openPromotion={state.data.openPromotion}
        history={promotions.data.items}
        canRequest={canRequest}
        canApprove={canApprove}
        currentUserId={session?.user.id ?? ''}
        approveId={approveId}
        onApproveHandled={onApproveHandled}
      />
    </div>
  );
}
