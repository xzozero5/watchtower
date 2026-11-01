'use client';

import { ConfidenceDots } from '@watchtower/ui';

import { useI18n } from '@/i18n/provider';
import { confidenceBand, formatConfidence } from '@/lib/ai/model';

/**
 * A confidence as a five-dot bar (docs/design/friendly-polish.md section 4). The word and the
 * number (`High 0.86`) are the meter's accessible name and its tooltip, never the dots alone (N5).
 */
export function ConfidenceMeter({ value, className }: { value: number; className?: string }) {
  const { t } = useI18n();
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
        text={`${t(`ai.brief.band.${band}`)} ${formatConfidence(value)}`}
        low={band === 'low'}
      />
    </span>
  );
}
