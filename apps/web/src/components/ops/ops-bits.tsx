'use client';

import type {
  Alert,
  AlertSource,
  AlertState,
  IncidentSeverity,
  IncidentStatus,
} from '@watchtower/shared';
import { SeverityBadge, Skeleton, TintChip, type ChipIcon, type TintId } from '@watchtower/ui';
import { BellOff, BellRing, CheckCheck, CircleCheck, Eye, Search, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';

import { useI18n } from '@/i18n/provider';
import { formatDateTime } from '@/lib/format';
import {
  ALERT_SEVERITY_LABELS,
  alertSeverityId,
  incidentSeverityId,
  INCIDENT_SEVERITY_LABELS,
  isSnoozed,
} from '@/lib/ops/model';
import { useNow } from '@/lib/use-now';

/** Alert severity as icon + P-code + word; an unmapped severity says so in words (UI spec Q10). */
export function AlertSeverityBadge({ severity }: { severity: Alert['severity'] }) {
  const { t } = useI18n();
  return (
    <SeverityBadge
      severity={alertSeverityId(severity)}
      label={t(ALERT_SEVERITY_LABELS[severity])}
    />
  );
}

/** Incident severity: the P1 to P4 tokens with the code SEV1 to SEV4. */
export function IncidentSeverityBadge({ severity }: { severity: IncidentSeverity }) {
  const { t } = useI18n();
  return (
    <SeverityBadge
      severity={incidentSeverityId(severity)}
      code={severity}
      label={t(INCIDENT_SEVERITY_LABELS[severity])}
    />
  );
}

const STATE_VIEW: Record<AlertState, { icon: ChipIcon; tone: TintId }> = {
  open: { icon: BellRing, tone: 'red' },
  acknowledged: { icon: CheckCheck, tone: 'teal' },
  resolved: { icon: CircleCheck, tone: 'green' },
};

/** The state in words with an icon; a snooze is a second chip, so it is never hidden behind "open". */
export function AlertStateChips({ alert }: { alert: Alert }) {
  const { t } = useI18n();
  const now = useNow();
  const view = STATE_VIEW[alert.state];
  return (
    <>
      <TintChip tone={view.tone} icon={view.icon}>
        {t(`ops.alerts.state.${alert.state}`)}
      </TintChip>
      {isSnoozed(alert, now) ? (
        <TintChip tone="amber" icon={BellOff}>
          {t('ops.alerts.state.snoozed')}
        </TintChip>
      ) : null}
    </>
  );
}

export function AlertSourceText({ source }: { source: AlertSource }) {
  const { t } = useI18n();
  return <>{t(`ops.alerts.source.${source}`)}</>;
}

const INCIDENT_STATUS_VIEW: Record<IncidentStatus, { icon: ChipIcon; tone: TintId }> = {
  investigating: { icon: Search, tone: 'red' },
  identified: { icon: Wrench, tone: 'amber' },
  monitoring: { icon: Eye, tone: 'sky' },
  resolved: { icon: CircleCheck, tone: 'green' },
};

export function IncidentStatusChip({ status }: { status: IncidentStatus }) {
  const { t } = useI18n();
  const view = INCIDENT_STATUS_VIEW[status];
  return (
    <TintChip tone={view.tone} icon={view.icon}>
      {t(`ops.incidents.status.${status}`)}
    </TintChip>
  );
}

/** A moment as "Nov 2, 2026, 08:00" in the display zone. */
export function Moment({ iso }: { iso: string }) {
  const { locale } = useI18n();
  return <time dateTime={iso}>{formatDateTime(iso, locale)}</time>;
}

/** Placeholder while an ops page loads; announced once. */
export function OpsSkeleton({ rows = 4 }: { rows?: number }) {
  const { t } = useI18n();
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-2 p-4">
      <span className="sr-only">{t('ops.common.loading')}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-9" />
      ))}
    </div>
  );
}

/** A label and its value on one line of a detail card. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}
