'use client';

import { cn } from '@watchtower/ui';

import { useI18n } from '@/i18n/provider';
import { formatDateTime, formatDuration } from '@/lib/format';
import { useNow } from '@/lib/use-now';

/**
 * A moment as a short age ("2m", "3h", "1d 4h") with the exact date and time on hover and for
 * assistive technology (docs/design/ai-first-workspace.md section 4). Under a minute it says "now".
 */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const { t, locale } = useI18n();
  const now = useNow();
  const age = now - Date.parse(iso);
  const exact = formatDateTime(iso, locale);
  return (
    <time dateTime={iso} title={exact} className={cn('tabular', className)}>
      {age < 60_000 ? t('admin.common.now') : formatDuration(age, locale)}
      <span className="sr-only"> ({exact})</span>
    </time>
  );
}
