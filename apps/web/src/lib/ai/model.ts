import type { AiState, TicketAiInsight } from '@watchtower/shared';

import type { RowModel } from '@/lib/tickets/model';

/**
 * Pure rules of the AI-first workspace (docs/design/ai-first-workspace.md): which section of the
 * triage board a row belongs to, how a confidence reads in words, what an edited draft changed.
 * Nothing here makes up AI content; it only arranges what the api sent.
 */

// --- triage board ---

export const TRIAGE_GROUPS = ['needsYou', 'aiWorking', 'waiting', 'done'] as const;
export type TriageGroup = (typeof TRIAGE_GROUPS)[number];

/** Groups that start folded: finished tickets are not what an agent triages. */
export const COLLAPSED_BY_DEFAULT: ReadonlySet<TriageGroup> = new Set<TriageGroup>(['done']);

/**
 * Which section a row sits in.
 *  - finished tickets (resolved, closed, merged) are `done`;
 *  - waiting on the customer or on dev is `waiting`, whatever the AI did;
 *  - a draft to approve, an AI that could not finish, or an SLA that is at risk needs a person:
 *    `needsYou`; so does a ticket the AI has not touched or has only classified (nothing else
 *    is working on it: classification is the AI's whole job until the investigator, T-108);
 *  - only a ticket the AI is still investigating is the AI's: `aiWorking`.
 */
export function triageGroup(row: Pick<RowModel, 'status' | 'ai' | 'sla'>): TriageGroup {
  if (row.status === 'resolved' || row.status === 'closed' || row.status === 'merged') {
    return 'done';
  }
  if (row.status === 'waiting_on_customer' || row.status === 'waiting_on_dev') return 'waiting';
  const state: AiState = row.ai?.state ?? 'none';
  if (state === 'draft_ready' || state === 'needs_human' || state === 'failed') return 'needsYou';
  if (row.sla.state === 'atRisk' || row.sla.state === 'breached') return 'needsYou';
  if (state === 'investigating') return 'aiWorking';
  return 'needsYou';
}

export interface RowGroup {
  /** `all` is the single, header-less section a customer sees (the AI triage board is for staff). */
  id: TriageGroup | 'all';
  rows: RowModel[];
}

/** A row held in the section it was in when it was opened (see `groupRows`). */
export interface PinnedRow {
  key: string;
  group: TriageGroup;
}

/**
 * The non-empty sections in board order; inside a section the api's order is kept. The open
 * ticket can be `pinned` to the section it was opened from: resolving it, or an AI update, then
 * does not make it jump to another section under the cursor (PRD section 10). It moves when
 * another ticket is opened.
 */
export function groupRows(rows: readonly RowModel[], pinned: PinnedRow | null = null): RowGroup[] {
  const buckets = new Map<TriageGroup, RowModel[]>();
  for (const row of rows) {
    const id = pinned?.key === row.key ? pinned.group : triageGroup(row);
    const bucket = buckets.get(id);
    if (bucket) bucket.push(row);
    else buckets.set(id, [row]);
  }
  return TRIAGE_GROUPS.flatMap((id) => {
    const bucket = buckets.get(id);
    return bucket ? [{ id, rows: bucket }] : [];
  });
}

/**
 * The rows J and K walk through, top to bottom as they are drawn: a folded section contributes
 * nothing, except the row that is open (so the cursor never disappears from under the person).
 */
export function navigableRows(
  groups: readonly RowGroup[],
  collapsed: ReadonlySet<string>,
  selectedKey: string | null,
): RowModel[] {
  return groups.flatMap((group) =>
    collapsed.has(group.id) ? group.rows.filter((row) => row.key === selectedKey) : group.rows,
  );
}

// --- confidence ---

export type ConfidenceBand = 'high' | 'medium' | 'low';

/** Bands from docs/06-UI-SPEC.md section 6.1 `[ASSUMED]`: at least 0.75, at least 0.4, below. */
export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= 0.75) return 'high';
  if (confidence >= 0.4) return 'medium';
  return 'low';
}

export const formatConfidence = (confidence: number): string => confidence.toFixed(2);

// --- the brief ---

/** What the brief area should do for a state: nothing to show, or a card with these parts. */
export function hasBrief(insight: TicketAiInsight | undefined): insight is TicketAiInsight {
  return insight !== undefined && insight.state !== 'none';
}

/** Evidence the draft cites, in the order the draft cites them. */
export function citedEvidence(insight: TicketAiInsight): TicketAiInsight['evidence'] {
  const ids = insight.draft?.citations ?? [];
  return ids.flatMap((id) => insight.evidence.filter((entry) => entry.id === id));
}

/**
 * A link from the api is shown only when it is a path inside Watchtower or an http(s) address
 * (never `javascript:` and the like).
 */
export function safeHref(href: string | undefined): string | null {
  if (!href) return null;
  if (href.startsWith('/') && !href.startsWith('//')) return href;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

// --- an edited draft ---

const words = (text: string): string[] => text.split(/\s+/).filter((word) => word !== '');

/**
 * How much of a draft a person changed, 0 to 1: one minus the share of words that survive in
 * order (longest common subsequence of words, over the longer text). The same text is 0, a
 * completely different one is 1.
 */
export function changedFraction(original: string, edited: string): number {
  const a = words(original);
  const b = words(edited);
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (const wordA of a) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      row[j] =
        wordA === b[j - 1]
          ? (previous[j - 1] ?? 0) + 1
          : Math.max(previous[j] ?? 0, row[j - 1] ?? 0);
    }
    previous = row;
  }
  const common = previous[b.length] ?? 0;
  return 1 - common / longest;
}
