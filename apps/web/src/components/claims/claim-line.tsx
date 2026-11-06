'use client';

import type { Claim, ClaimEvidence, ClaimEvidenceKind } from '@watchtower/shared';
import { cn, TintChip } from '@watchtower/ui';
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Clock,
  Database,
  FileText,
  GitCommitHorizontal,
  HandHelping,
  type LucideIcon,
  Mail,
  Radio,
  Rocket,
  ScrollText,
  Settings,
  StickyNote,
  Tags,
  Ticket,
  TriangleAlert,
  User,
} from 'lucide-react';

import { AppLink } from '@/components/app-link';
import { evidenceHref } from '@/components/ai/evidence-href';
import { useT } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';

/** One icon per kind of claim evidence (T-135). The word is the label; the icon is a second cue. */
const KIND_ICONS: Record<ClaimEvidenceKind, LucideIcon> = {
  ticket: Ticket,
  kb: FileText,
  incident: AlertTriangle,
  alert: Bell,
  deploy: Rocket,
  note: StickyNote,
  handoff: HandHelping,
  log: ScrollText,
  data: Database,
  repo: GitCommitHorizontal,
  person: User,
  // ADR-029 section 5: the kinds the stage 1 module tools add.
  conversation: Mail,
  statuspage: Radio,
  shift: Clock,
  metric: BarChart3,
  intent: Tags,
  config: Settings,
  org: Database,
  service: Settings,
};

const CHIP =
  'inline-flex max-w-full items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-xs text-foreground ring-1 ring-border ring-inset';

/**
 * A source a claim stands on: kind icon + label, a link when the source has a page this person may
 * open, and plain text with "No page to open" when it has none. A `mock` source says `Demo`; it is
 * never shown as a number or as certainty (N5).
 */
export function EvidenceChip({
  evidence,
  canOpenOrgs,
  onOpen,
}: {
  evidence: ClaimEvidence;
  canOpenOrgs: boolean;
  /** Called after a link inside the app is followed (a full-screen panel closes itself). */
  onOpen?: () => void;
}) {
  const t = useT();
  const Icon = KIND_ICONS[evidence.kind];
  const href = evidenceHref(evidence.href, canOpenOrgs);
  const inner = (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
      <span className="min-w-0 truncate">{evidence.label}</span>
    </>
  );
  const demo = evidence.mock === true;
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      {href === null ? (
        <span className={CHIP} title={t('assistant.answer.noLink')}>
          {inner}
          <span className="sr-only">{t('assistant.answer.noLink')}</span>
        </span>
      ) : href.startsWith('/') ? (
        <AppLink
          href={href}
          onClick={onOpen}
          className={cn(
            CHIP,
            'text-link underline hover:bg-primary-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          )}
        >
          {inner}
        </AppLink>
      ) : (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            CHIP,
            'text-link underline hover:bg-primary-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          )}
        >
          {inner}
        </a>
      )}
      {demo ? (
        <TintChip tone="slate" title={t('assistant.answer.demoTip')}>
          {t('assistant.answer.demo')}
        </TintChip>
      ) : null}
    </span>
  );
}

/**
 * One AI sentence with the pages that support it (T-135, N5). A claim with no evidence is flagged
 * `No evidence` (icon + words, never colour alone) and written muted: it is not shown as a fact.
 * Render it inside a `<ul>`.
 */
export function ClaimLine({ claim, onOpen }: { claim: Claim; onOpen?: () => void }) {
  const t = useT();
  const { can } = useSession();
  const canOpenOrgs = can('org.manage');
  return (
    <li className="flex flex-col gap-1">
      <p
        className={cn(
          'text-sm',
          claim.uncited ? 'text-muted-foreground italic' : 'text-foreground',
        )}
      >
        {claim.text}
      </p>
      {claim.uncited ? (
        <span>
          <TintChip tone="amber" icon={TriangleAlert} title={t('assistant.answer.uncitedTip')}>
            {t('assistant.answer.uncited')}
          </TintChip>
        </span>
      ) : (
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label={t('assistant.answer.evidence')}
        >
          {claim.evidence.map((evidence, index) => (
            <EvidenceChip
              key={`${evidence.kind}-${evidence.label}-${String(index)}`}
              evidence={evidence}
              canOpenOrgs={canOpenOrgs}
              {...(onOpen ? { onOpen } : {})}
            />
          ))}
        </div>
      )}
    </li>
  );
}
