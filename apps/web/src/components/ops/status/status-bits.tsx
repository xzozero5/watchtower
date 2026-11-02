'use client';

import type {
  StatusComponentStatus,
  StatusOverall,
  StatusPostImpact,
  StatusPostPhase,
} from '@watchtower/shared';
import { TintChip, type ChipIcon, type TintId } from '@watchtower/ui';
import {
  CircleCheck,
  Eye,
  OctagonAlert,
  Search,
  TrendingDown,
  TriangleAlert,
  Wrench,
} from 'lucide-react';

import { useI18n } from '@/i18n/provider';

/** Icon and hue per component status. The words always say it too; the icon shapes differ. */
export const COMPONENT_STATUS_VIEW: Record<
  StatusComponentStatus,
  { icon: ChipIcon; tone: TintId }
> = {
  operational: { icon: CircleCheck, tone: 'green' },
  degraded_performance: { icon: TrendingDown, tone: 'amber' },
  partial_outage: { icon: TriangleAlert, tone: 'amber' },
  major_outage: { icon: OctagonAlert, tone: 'red' },
  under_maintenance: { icon: Wrench, tone: 'sky' },
};

export function StatusComponentChip({ status }: { status: StatusComponentStatus }) {
  const { t } = useI18n();
  const view = COMPONENT_STATUS_VIEW[status];
  return (
    <TintChip tone={view.tone} icon={view.icon} strong={status === 'major_outage'}>
      {t(`ops.status.component.${status}`)}
    </TintChip>
  );
}

export const OVERALL_VIEW: Record<StatusOverall, { icon: ChipIcon; tone: TintId }> = {
  operational: { icon: CircleCheck, tone: 'green' },
  degraded: { icon: TrendingDown, tone: 'amber' },
  outage: { icon: OctagonAlert, tone: 'red' },
  maintenance: { icon: Wrench, tone: 'sky' },
};

const PHASE_VIEW: Record<StatusPostPhase, { icon: ChipIcon; tone: TintId }> = {
  investigating: { icon: Search, tone: 'red' },
  identified: { icon: Wrench, tone: 'amber' },
  monitoring: { icon: Eye, tone: 'sky' },
  resolved: { icon: CircleCheck, tone: 'green' },
};

export function StatusPhaseChip({ phase }: { phase: StatusPostPhase }) {
  const { t } = useI18n();
  const view = PHASE_VIEW[phase];
  return (
    <TintChip tone={view.tone} icon={view.icon}>
      {t(`ops.status.phase.${phase}`)}
    </TintChip>
  );
}

export function ImpactText({ impact }: { impact: StatusPostImpact }) {
  const { t } = useI18n();
  return <>{t(`ops.status.impact.${impact}`)}</>;
}
