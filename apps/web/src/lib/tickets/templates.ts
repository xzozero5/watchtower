import {
  DEFAULT_STATUS_TRANSITIONS,
  SETTABLE_STATUSES,
  type TicketStatus,
  type Workflow,
} from '@watchtower/shared';

/**
 * Reply templates (R-1.4) are stored per intent with `{{variable}}` placeholders. This is the
 * stub the composer uses until macros and AI drafts arrive: it fills the variables the ticket
 * knows and leaves the rest visible, so a half-filled template can never be sent unnoticed.
 */
export const TEMPLATE_VARIABLES = [
  'requester.name',
  'ticket.key',
  'ticket.subject',
  'org.name',
  'agent.name',
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];
export type TemplateValues = Partial<Record<TemplateVariable, string>>;

const PLACEHOLDER = /\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g;

export interface RenderedTemplate {
  text: string;
  /** Placeholders that stayed in the text: unknown names, or values this ticket does not have. */
  unresolved: string[];
}

export function renderTemplate(body: string, values: TemplateValues): RenderedTemplate {
  const unresolved = new Set<string>();
  const text = body.replace(PLACEHOLDER, (whole, name: string) => {
    const value = (TEMPLATE_VARIABLES as readonly string[]).includes(name)
      ? values[name as TemplateVariable]
      : undefined;
    if (value === undefined || value.trim() === '') {
      unresolved.add(name);
      return whole;
    }
    return value;
  });
  return { text, unresolved: [...unresolved] };
}

/** Names of placeholders still present in `text`, in order of first appearance. */
export function findPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

/** Statuses a ticket may move to from `current`, by the configured workflow (or the defaults). */
export function allowedNextStatuses(
  workflow: Workflow | undefined,
  current: TicketStatus,
): TicketStatus[] {
  const settable = SETTABLE_STATUSES as readonly TicketStatus[];
  const next = workflow
    ? workflow.transitions.filter((entry) => entry.from === current).map((entry) => entry.to)
    : [...DEFAULT_STATUS_TRANSITIONS[current]];
  return next.filter((status) => settable.includes(status) && status !== current);
}

/**
 * Unsent text per ticket and mode, kept for the life of the page so moving to another ticket with
 * J/K and back does not lose a half-written reply. Memory only: nothing is written to disk.
 */
const drafts = new Map<string, string>();
const draftKey = (ticketKey: string, mode: 'reply' | 'note') => `${ticketKey}:${mode}`;

export const draftStore = {
  get: (ticketKey: string, mode: 'reply' | 'note') => drafts.get(draftKey(ticketKey, mode)) ?? '',
  set(ticketKey: string, mode: 'reply' | 'note', text: string) {
    if (text === '') drafts.delete(draftKey(ticketKey, mode));
    else drafts.set(draftKey(ticketKey, mode), text);
  },
  clear: () => {
    drafts.clear();
  },
};
