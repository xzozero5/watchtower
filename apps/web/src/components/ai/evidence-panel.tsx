'use client';

import type { AiEvidence } from '@watchtower/shared';
import { Button, cn, Skeleton, TintChip } from '@watchtower/ui';
import { Bot, ExternalLink, Quote } from 'lucide-react';
import { useState } from 'react';

import { useI18n } from '@/i18n/provider';
import { confidenceBand, formatConfidence, isDemoInsight } from '@/lib/ai/model';
import { stripMarkdown } from '@/lib/ai/prose';
import { useTicketAi } from '@/lib/ai/queries';
import { useSession } from '@/lib/auth/session';

import { DemoChip } from './confidence-meter';
import { evidenceHref } from './evidence-href';
import { EVIDENCE_ICONS } from './evidence-icons';
import { splitEvidence } from './evidence-split';

/** The DOM id of an evidence card, so a chip or a citation can move focus to it. */
export const evidenceDomId = (id: string) => `evidence-card-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;

function EvidenceCard({
  entry,
  cited,
  highlighted,
  demo,
  canOpenOrgs,
}: {
  entry: AiEvidence;
  cited: boolean;
  highlighted: boolean;
  demo: boolean;
  canOpenOrgs: boolean;
}) {
  const { t } = useI18n();
  const Icon = EVIDENCE_ICONS[entry.kind];
  const href = evidenceHref(entry.href, canOpenOrgs);
  const external = href !== null && !href.startsWith('/');
  return (
    <li
      id={evidenceDomId(entry.id)}
      tabIndex={-1}
      data-highlighted={highlighted ? 'true' : undefined}
      className={cn(
        'flex flex-col gap-1.5 rounded-lg bg-surface px-4 py-3 text-sm ring-1 ring-border/70 outline-hidden ring-inset focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        highlighted && 'bg-ai-subtle ring-2 ring-ai-accent',
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon aria-hidden className="size-3.5 shrink-0 text-ai-accent" />
        <span>{t(`ai.evidence.kinds.${entry.kind}`)}</span>
        {/* A retrieval score is how well it matches, not a probability: a word and the number (spec 6.2). */}
        <span className="ml-auto">
          {demo ? (
            <DemoChip />
          ) : (
            <span
              data-testid="evidence-relevance"
              title={t('ai.evidence.relevanceTip')}
              className="font-medium text-foreground"
            >
              {t('ai.evidence.relevance', {
                band: t(`ai.brief.band.${confidenceBand(entry.confidence)}`),
                value: formatConfidence(entry.confidence),
              })}
            </span>
          )}
        </span>
      </div>
      <p className="font-medium text-foreground">{entry.title}</p>
      {/* Markdown is shown as plain text: the marks are removed, nothing is rendered as HTML. */}
      <p className="line-clamp-3 text-muted-foreground">{stripMarkdown(entry.snippet)}</p>
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
}

/**
 * The Evidence tab: every source the AI used, one card each (docs/06-UI-SPEC.md section 6.2) with
 * the kind as icon and words, the title, a short quote, the relevance as word and number, and a
 * link to the source when the api gave a safe one. Cards scoring below `WEAK_EVIDENCE_THRESHOLD`
 * are folded behind "Show N weaker matches" (a cited or pointed-at card is not). A card the draft
 * cites says so. The card a chip pointed at is outlined. Nothing here is made up: no brief, no cards.
 */
export function EvidencePanel({
  ticketKey,
  highlightId,
}: {
  ticketKey: string | null;
  highlightId: string | null;
}) {
  const { t } = useI18n();
  const { can } = useSession();
  const query = useTicketAi(ticketKey, true);
  const [showWeak, setShowWeak] = useState(false);

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
  const demo = isDemoInsight(query.data);
  if (evidence.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">{t('ai.evidence.empty')}</p>;
  }
  const citedIds = draft?.citations ?? [];
  const { strong, weak } = splitEvidence(evidence, { citedIds, highlightId, demo });
  const canOpenOrgs = can('org.manage');
  const card = (entry: AiEvidence) => (
    <EvidenceCard
      key={entry.id}
      entry={entry}
      cited={citedIds.includes(entry.id)}
      highlighted={highlightId === entry.id}
      demo={demo}
      canOpenOrgs={canOpenOrgs}
    />
  );

  return (
    <div className="flex flex-col gap-2 p-3">
      {strong.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('ai.evidence.onlyWeaker', { count: weak.length })}
        </p>
      ) : null}
      <ul aria-label={t('ai.evidence.tab')} className="flex flex-col gap-2">
        {strong.map(card)}
        {showWeak ? weak.map(card) : null}
      </ul>
      {weak.length > 0 ? (
        <Button
          variant="ghost"
          className="self-start rounded-full"
          aria-expanded={showWeak}
          onClick={() => {
            setShowWeak((current) => !current);
          }}
        >
          {showWeak
            ? t('ai.evidence.hideWeaker')
            : t('ai.evidence.showWeaker', { count: weak.length })}
        </Button>
      ) : null}
    </div>
  );
}
