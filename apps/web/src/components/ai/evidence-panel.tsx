'use client';

import { cn, Skeleton, TintChip } from '@watchtower/ui';
import { Bot, ExternalLink, Quote } from 'lucide-react';

import { useI18n } from '@/i18n/provider';
import { confidenceBand, formatConfidence, safeHref } from '@/lib/ai/model';
import { useTicketAi } from '@/lib/ai/queries';

import { EVIDENCE_ICONS } from './ai-brief';

/** The DOM id of an evidence card, so a chip or a citation can move focus to it. */
export const evidenceDomId = (id: string) => `evidence-card-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;

/**
 * The Evidence tab: every source the AI used, one card each (docs/06-UI-SPEC.md section 6.2) with
 * the kind as icon and words, the title, a short quote, the confidence as word and number, and a
 * link to the source when the api gave a safe one. A card the draft cites says so. The card a chip
 * pointed at is outlined. Nothing here is made up: no brief, no cards.
 */
export function EvidencePanel({
  ticketKey,
  highlightId,
}: {
  ticketKey: string | null;
  highlightId: string | null;
}) {
  const { t } = useI18n();
  const query = useTicketAi(ticketKey, true);

  if (ticketKey === null) {
    return <p className="p-4 text-sm text-muted-foreground">{t('panel.noTicket')}</p>;
  }
  if (query.isPending) {
    return (
      <div role="status" className="flex flex-col gap-3 p-4">
        <span className="sr-only">{t('ai.brief.loading')}</span>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Bot aria-hidden className="size-4 shrink-0" />
        {t('ai.brief.unavailable')}
      </p>
    );
  }

  const { evidence, draft } = query.data;
  if (evidence.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">{t('ai.evidence.empty')}</p>;
  }

  return (
    <ul aria-label={t('ai.evidence.tab')} className="flex flex-col gap-2 p-3">
      {evidence.map((entry) => {
        const Icon = EVIDENCE_ICONS[entry.kind];
        const href = safeHref(entry.href);
        const external = href !== null && !href.startsWith('/');
        const cited = draft?.citations.includes(entry.id) ?? false;
        return (
          <li
            key={entry.id}
            id={evidenceDomId(entry.id)}
            tabIndex={-1}
            data-highlighted={highlightId === entry.id ? 'true' : undefined}
            className={cn(
              'flex flex-col gap-1.5 rounded-lg bg-surface px-4 py-3 text-sm ring-1 ring-border/70 outline-hidden ring-inset focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
              highlightId === entry.id && 'bg-ai-subtle ring-2 ring-ai-accent',
            )}
          >
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Icon aria-hidden className="size-3.5 shrink-0 text-ai-accent" />
              <span>{t(`ai.evidence.kinds.${entry.kind}`)}</span>
              <span className="tabular ml-auto font-medium text-foreground">
                {t(`ai.brief.band.${confidenceBand(entry.confidence)}`)}{' '}
                {formatConfidence(entry.confidence)}
              </span>
            </div>
            <p className="font-medium text-foreground">{entry.title}</p>
            <p className="text-muted-foreground">{entry.snippet}</p>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {cited ? (
                <TintChip tone="teal" icon={Quote}>
                  {t('ai.evidence.cited')}
                </TintChip>
              ) : null}
              {href ? (
                <a
                  href={href}
                  {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                  className="ml-auto inline-flex items-center gap-1 text-link hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {t('ai.evidence.open')}
                  {external ? <ExternalLink aria-hidden className="size-3" /> : null}
                </a>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
