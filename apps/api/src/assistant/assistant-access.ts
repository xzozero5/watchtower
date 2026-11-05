import type {
  AssistantLocale,
  AssistantStarter,
  Permission,
  ProposalKind,
} from '@watchtower/shared';

import { satisfiesRequirement, type PermissionRequirement } from '../auth/permission-check.js';
import type { Principal } from '../auth/principal.js';

/**
 * What the assistant may do for whom (ADR-023 sections 1 to 3). Two locks, and a tool or a proposal
 * needs both: the role is on the list (code, not the model, decides), and the person holds the
 * permission of the ordinary route behind it. A role that is not on a list gets nothing: deny by
 * default. `client` and `system` are absent on purpose (po #34, N3).
 *
 * `dev` is a role of T-137 that is not in `ROLES` on this branch, so the lists are keyed by plain
 * strings and the entry is ready for when it exists. `[ASSUMED]` until T-137 merges.
 */
export const ASSISTANT_TOOLS = [
  'search_tickets',
  'summarize_ticket',
  'explain_sla',
  'team_load',
  'team_status',
  'kb_search',
  'investigate_run',
] as const;
export type AssistantToolName = (typeof ASSISTANT_TOOLS)[number];

const STAFF_TOOLS: readonly AssistantToolName[] = [
  'search_tickets',
  'summarize_ticket',
  'explain_sla',
  'team_status',
  'kb_search',
  'investigate_run',
];

export const ROLE_TOOLS: Readonly<Record<string, readonly AssistantToolName[]>> = {
  agent: STAFF_TOOLS,
  lead: [...STAFF_TOOLS, 'team_load'],
  head: [...STAFF_TOOLS, 'team_load'],
  // Masked reader: finds, reads and investigates, does not see the team or the roster.
  dev: ['search_tickets', 'summarize_ticket', 'explain_sla', 'kb_search', 'investigate_run'],
};

/**
 * What the tool asks of the person: the same shape as the decorators of the GET route that serves the same data
 * (`all` = RequirePermission, `anyOf` = RequireAnyPermission) and checked by the same evaluator as the guard
 * (`satisfiesRequirement`). No shortcut: `ticket.read.masked` satisfies only a requirement that names it (T-400 C-1).
 * A permission of the client alone (`ticket.read.org`) is left out; the client never reaches the assistant.
 */
export const TOOL_PERMISSION: Readonly<Record<AssistantToolName, PermissionRequirement>> = {
  search_tickets: { anyOf: ['ticket.read', 'ticket.read.masked'] },
  summarize_ticket: { anyOf: ['ticket.read', 'ticket.read.masked'] },
  explain_sla: { anyOf: ['ticket.read', 'ticket.read.masked'] },
  team_load: { all: ['ticket.read'] },
  team_status: { all: ['ticket.handle'] },
  kb_search: { all: ['kb.read'] },
  investigate_run: { all: ['investigate.run'] },
};

/**
 * The GET route that serves the same data as the tool (ADR-029 section 2, `toolRoute`). The parity test reads the
 * decorator of that route and fails when `TOOL_PERMISSION` is not one of the permissions the route accepts, and
 * the output of the tool must be within what the route returns to the same person. A tool without a GET route to
 * point at does not belong in the catalogue.
 */
export const TOOL_ROUTE: Readonly<Record<AssistantToolName, string>> = {
  search_tickets: 'GET /v1/tickets',
  summarize_ticket: 'GET /v1/tickets/:id',
  explain_sla: 'GET /v1/tickets/:id',
  team_load: 'GET /v1/tickets/stats',
  team_status: 'GET /v1/assignees',
  kb_search: 'GET /v1/kb/search',
  investigate_run: 'GET /v1/tickets/:id/tools',
};

export const ROLE_PROPOSALS: Readonly<Record<string, readonly ProposalKind[]>> = {
  agent: ['assign', 'status', 'tag', 'note', 'create_ticket', 'kb_draft', 'reply_draft'],
  lead: ['assign', 'status', 'tag', 'note', 'create_ticket', 'kb_draft', 'reply_draft'],
  head: ['assign', 'status', 'tag', 'note', 'create_ticket', 'kb_draft', 'reply_draft'],
  // po #33: moves a ticket between open and waiting-on-dev with a note; never reaches a customer.
  dev: ['status', 'note'],
};

/** The permission of the ordinary route that makes the same change. */
export const PROPOSAL_PERMISSION: Readonly<Record<ProposalKind, Permission>> = {
  assign: 'ticket.handle',
  status: 'ticket.handle',
  tag: 'ticket.handle',
  note: 'ticket.handle',
  create_ticket: 'ticket.create',
  kb_draft: 'kb.write',
  reply_draft: 'ticket.handle',
};

type Holder = Pick<Principal, 'role' | 'permissions'>;

/**
 * Masked (T-137, po #33): the person reads tickets with personal data masked, holding `ticket.read.masked`
 * and not `ticket.read`. The same rule as the ticket reader's, so what it serves and what the assistant
 * says about the same ticket agree. Holding both is the full read.
 */
export const isMasked = (principal: Holder): boolean =>
  principal.permissions.has('ticket.read.masked') && !principal.permissions.has('ticket.read');

/** May the person read tickets at all, whole or masked? */
export const canUseAssistant = (principal: Holder): boolean =>
  principal.permissions.has('ticket.read') || principal.permissions.has('ticket.read.masked');


/**
 * The permission the ordinary route asks for this change from this person. A masked reader changes a
 * ticket as a developer does (a status and a note), not as support does.
 */
export function proposalPermission(kind: ProposalKind, principal: Holder): Permission {
  return isMasked(principal) && (kind === 'status' || kind === 'note')
    ? 'ticket.dev.work'
    : PROPOSAL_PERMISSION[kind];
}

/** Tools this person may use right now: on the role list and backed by a permission they hold. */
export function toolsFor(principal: Holder): AssistantToolName[] {
  return (ROLE_TOOLS[principal.role] ?? []).filter((name) =>
    satisfiesRequirement(principal.permissions, TOOL_PERMISSION[name]),
  );
}

export function proposalKindsFor(principal: Holder): ProposalKind[] {
  return (ROLE_PROPOSALS[principal.role] ?? []).filter((kind) =>
    principal.permissions.has(proposalPermission(kind, principal)),
  );
}

// --- starter prompts -----------------------------------------------------------------------------

interface StarterDef {
  readonly id: string;
  readonly text: Readonly<Record<AssistantLocale, string>>;
  /** Talks about "this" ticket: offered only when a ticket chip is on. */
  readonly needsTicket?: true;
  /** The tool or proposal it leans on, so a person who cannot use it is not offered it. */
  readonly tool?: AssistantToolName;
  readonly proposal?: ProposalKind;
}

const DEFS: Readonly<Record<string, StarterDef>> = {
  summarize: {
    id: 'summarize_this',
    text: { th: 'สรุปเรื่องนี้', en: 'Summarize this' },
    needsTicket: true,
    tool: 'summarize_ticket',
  },
  similar: {
    id: 'find_similar',
    text: { th: 'หาเคสคล้ายกัน', en: 'Find similar tickets' },
    needsTicket: true,
    tool: 'search_tickets',
  },
  draft: {
    id: 'draft_reply',
    text: { th: 'ร่างคำตอบ', en: 'Draft a reply' },
    needsTicket: true,
    proposal: 'reply_draft',
  },
  evidence: {
    id: 'sum_evidence',
    text: { th: 'สรุปหลักฐาน', en: 'Sum up the evidence' },
    needsTicket: true,
    tool: 'summarize_ticket',
  },
  mine: {
    id: 'my_tickets',
    text: { th: 'งานของฉัน', en: 'My tickets' },
    tool: 'search_tickets',
  },
  sla: {
    id: 'sla_risk',
    text: { th: 'อะไรเสี่ยง SLA', en: 'What is at SLA risk' },
    tool: 'search_tickets',
  },
  overloaded: {
    id: 'overloaded',
    text: { th: 'ใครงานล้น', en: "Who's overloaded" },
    tool: 'team_load',
  },
  team: { id: 'team_status', text: { th: 'สถานะทีม', en: 'Team status' }, tool: 'team_status' },
  guide: { id: 'find_guide', text: { th: 'หาคู่มือ', en: 'Find a guide' }, tool: 'kb_search' },
};

/** In order of preference per role (design section 2.4, limited to what the tools can do). */
const ROLE_STARTERS: Readonly<Record<string, readonly string[]>> = {
  agent: ['summarize', 'similar', 'draft', 'mine', 'sla', 'guide'],
  lead: ['sla', 'overloaded', 'team', 'summarize', 'draft', 'mine'],
  head: ['sla', 'overloaded', 'team', 'summarize', 'mine'],
  dev: ['mine', 'evidence', 'guide', 'summarize'],
};

/** At most three prompts, none the person could not follow up on, none about "this" without a ticket chip. */
export function startersFor(
  principal: Holder,
  locale: AssistantLocale,
  hasTicket: boolean,
): AssistantStarter[] {
  const tools = new Set(toolsFor(principal));
  const proposals = new Set(proposalKindsFor(principal));
  const picked: AssistantStarter[] = [];
  for (const name of ROLE_STARTERS[principal.role] ?? []) {
    const def = DEFS[name];
    if (def === undefined) continue;
    if (def.needsTicket === true && !hasTicket) continue;
    if (def.tool !== undefined && !tools.has(def.tool)) continue;
    if (def.proposal !== undefined && !proposals.has(def.proposal)) continue;
    picked.push({ id: def.id, text: def.text[locale] });
    if (picked.length === 3) break;
  }
  return picked;
}
