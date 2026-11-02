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
export function triageGroup(
  row: Pick<RowModel, 'status' | 'ai' | 'sla'> &
    Partial<Pick<RowModel, 'priority'>> &
    Partial<Pick<RowModel, 'assigneeId' | 'queueId' | 'unassigned'>>,
  scope?: TriageScope,
): TriageGroup {
  const group = rawTriageGroup(row);
  // "Needs you" is for me: a ticket someone else holds is theirs to act on, so for me it waits.
  if (group === 'needsYou' && scope && !needsMe(row, scope)) return 'waiting';
  return group;
}

/** Who "you" are for the board: the signed-in person and the team queues they belong to. */
export interface TriageScope {
  userId: string;
  /** Ids of the queues the person is a member of; null while unknown (then any queue counts). */
  queueIds: ReadonlySet<string> | null;
}

/**
 * Whether a ticket that needs a person needs me: it is assigned to me, or it is unassigned and sits
 * in one of my queues (or in no queue, or my queues are not known yet).
 */
export function needsMe(
  row: Partial<Pick<RowModel, 'assigneeId' | 'queueId' | 'unassigned'>>,
  scope: TriageScope,
): boolean {
  const assigneeId = row.assigneeId ?? null;
  if (assigneeId !== null) return assigneeId === scope.userId;
  if (row.unassigned === false) return false; // assigned, but the id is not known: not provably mine
  if (scope.queueIds === null || !row.queueId) return true;
  return scope.queueIds.has(row.queueId);
}

function rawTriageGroup(
  row: Pick<RowModel, 'status' | 'ai' | 'sla'> & Partial<Pick<RowModel, 'priority'>>,
): TriageGroup {
  if (row.status === 'resolved' || row.status === 'closed' || row.status === 'merged') {
    return 'done';
  }
  if (row.status === 'waiting_on_customer' || row.status === 'waiting_on_dev') return 'waiting';
  // A P1 and a clock that is breached or at risk need a person whatever the AI is doing (QA-02).
  if (row.priority === 'P1') return 'needsYou';
  if (row.sla.state === 'atRisk' || row.sla.state === 'breached') return 'needsYou';
  const state: AiState = row.ai?.state ?? 'none';
  if (state === 'draft_ready' || state === 'needs_human' || state === 'failed') return 'needsYou';
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
export function groupRows(
  rows: readonly RowModel[],
  pinned: PinnedRow | null = null,
  scope?: TriageScope,
): RowGroup[] {
  const buckets = new Map<TriageGroup, RowModel[]>();
  for (const row of rows) {
    // A pin never keeps a ticket in "Needs you" once it is no longer mine (re-assigned away).
    const pin = pinned?.key === row.key ? pinned : null;
    const id =
      pin && !(pin.group === 'needsYou' && scope && !needsMe(row, scope))
        ? pin.group
        : triageGroup(row, scope);
    const bucket = buckets.get(id);
    if (bucket) bucket.push(row);
    else buckets.set(id, [row]);
  }
  return TRIAGE_GROUPS.flatMap((id) => {
    const bucket = buckets.get(id);
    return bucket ? [{ id, rows: sortBySlaThenPriority(bucket) }] : [];
  });
}

const SLA_RANK: Record<RowModel['sla']['state'], number> = {
  breached: 0,
  atRisk: 1,
  onTrack: 2,
  paused: 2,
  met: 2,
  none: 2,
};

const PRIORITY_RANK: Record<RowModel['priority'], number> = { P1: 1, P2: 2, P3: 3, P4: 4 };

/**
 * Inside a section: breached, then at risk, then the rest; then priority (P1 first); then the SLA due
 * time (soonest first, no running SLA last). Equal rows keep the order the api sent.
 */
export function sortBySlaThenPriority(rows: readonly RowModel[]): RowModel[] {
  const due = (row: RowModel): number => {
    if (row.sla.dueAt === null) return Number.POSITIVE_INFINITY;
    const at = Date.parse(row.sla.dueAt);
    return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
  };
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const byState = SLA_RANK[a.row.sla.state] - SLA_RANK[b.row.sla.state];
      if (byState !== 0) return byState;
      const byPriority = PRIORITY_RANK[a.row.priority] - PRIORITY_RANK[b.row.priority];
      if (byPriority !== 0) return byPriority;
      const byDue = due(a.row) - due(b.row);
      if (byDue !== 0 && !Number.isNaN(byDue)) return byDue;
      return a.index - b.index;
    })
    .map(({ row }) => row);
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

/**
 * A score as a number for a tooltip. A score that rounds up to 1.00 is shown as `> 0.99`: no
 * retrieval or model is certain, and a "1.00" reads as a guarantee (docs/design/less-text-ai-assistant.md
 * section 4).
 */
export const formatConfidence = (confidence: number): string =>
  confidence >= 0.995 ? '> 0.99' : confidence.toFixed(2);

/**
 * The run used a stand-in provider (`AI_PROVIDER=mock`, sample data): the report says so per tool.
 * Its numbers and its confidence mean nothing, so the screen shows a `Demo` chip and no number or
 * dots (N5). The evidence rows carry no flag of their own yet, so one mock tool marks the whole
 * brief `[ASSUMED]`.
 */
export function isDemoInsight(insight: Pick<TicketAiInsight, 'report'>): boolean {
  return insight.report?.tools.some((tool) => tool.mock) ?? false;
}

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
