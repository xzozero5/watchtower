import type {
  AssistantLocale,
  AssistantStarter,
  Permission,
  ProposalKind,
} from '@watchtower/shared';

import type { Principal } from '../auth/principal.js';

/**
 * What the assistant may do for whom (ADR-017 sections 1 to 3). Two locks, and a tool or a proposal
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

/** The permission of the ordinary route that serves the same data. */
export const TOOL_PERMISSION: Readonly<Record<AssistantToolName, Permission>> = {
  search_tickets: 'ticket.read',
  summarize_ticket: 'ticket.read',
  explain_sla: 'ticket.read',
  team_load: 'ticket.read',
  team_status: 'ticket.handle',
  kb_search: 'kb.read',
  investigate_run: 'investigate.run',
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

/**
 * T-137 (`origin/wip/t-137`, `[ASSUMED]` until it merges): the developer reads every ticket with personal
 * data masked through `ticket.read.masked` instead of `ticket.read`, and works on a ticket with
 * `ticket.dev.work` instead of `ticket.handle`. The names are written as plain permissions here so this
 * branch stands on its own; once T-137 is merged they are in `Permission` and the casts can go.
 */
export const MASKED_READ = 'ticket.read.masked' as Permission;
export const DEV_WORK = 'ticket.dev.work' as Permission;

type Holder = Pick<Principal, 'role' | 'permissions'>;

/** `dev` sees tickets without the customer's identity (po #33): by role, or by holding only the masked read. */
export const isMasked = (principal: Holder): boolean =>
  (principal.role as string) === 'dev' ||
  (principal.permissions.has(MASKED_READ) && !principal.permissions.has('ticket.read'));

/** May the person read tickets at all, whole or masked? The one question the routes ask. */
export const canUseAssistant = (principal: Holder): boolean =>
  principal.permissions.has('ticket.read') || principal.permissions.has(MASKED_READ);

/** A permission held, where reading a ticket is satisfied by the masked read too (the data is masked then). */
function holds(principal: Holder, permission: Permission): boolean {
  if (permission === 'ticket.read') return canUseAssistant(principal);
  return principal.permissions.has(permission);
}

/**
 * The permission the ordinary route asks for this change from this person. A masked reader changes a
 * ticket as a developer does (a status and a note), not as support does.
 */
export function proposalPermission(kind: ProposalKind, principal: Holder): Permission {
  return isMasked(principal) && (kind === 'status' || kind === 'note')
    ? DEV_WORK
    : PROPOSAL_PERMISSION[kind];
}

/** Tools this person may use right now: on the role list and backed by a permission they hold. */
export function toolsFor(principal: Holder): AssistantToolName[] {
  return (ROLE_TOOLS[principal.role] ?? []).filter((name) =>
    holds(principal, TOOL_PERMISSION[name]),
  );
}

export function proposalKindsFor(principal: Holder): ProposalKind[] {
  return (ROLE_PROPOSALS[principal.role] ?? []).filter((kind) =>
    holds(principal, proposalPermission(kind, principal)),
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
