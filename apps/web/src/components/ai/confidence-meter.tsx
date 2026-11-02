'use client';

import { ConfidenceDots, TintChip } from '@watchtower/ui';
import { FlaskConical } from 'lucide-react';

import { useI18n } from '@/i18n/provider';
import { confidenceBand, formatConfidence } from '@/lib/ai/model';

/** The chip that stands in for every number of a run that used a stand-in AI (N5). */
export function DemoChip() {
  const { t } = useI18n();
  return (
    <TintChip tone="slate" icon={FlaskConical} title={t('ai.brief.demoTip')}>
      {t('ai.brief.demo')}
    </TintChip>
  );
}

/**
 * A confidence as a five-dot bar (docs/design/friendly-polish.md section 4). The word is drawn
 * beside the dots; the word and the number (`High 0.86`) are the meter's accessible name and its
 * tooltip, never the dots alone (N5). In a demo run (a stand-in AI) there is no number and no
 * dots: the `Demo` chip says what the numbers would have been worth.
 */
export function ConfidenceMeter({
  value,
  demo = false,
  className,
}: {
  value: number;
  demo?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  if (demo) {
    return (
      <span className={className}>
        <DemoChip />
      </span>
    );
  }
  const band = confidenceBand(value);
  const text = t('ai.brief.confidence', {
    band: t(`ai.brief.band.${band}`),
    value: formatConfidence(value),
  });
  return (
    <span data-band={band} className={className}>
      <ConfidenceDots
        value={value}
        label={text}
        text={t(`ai.brief.band.${band}`)}
        low={band === 'low'}
      />
    </span>
  );
}
