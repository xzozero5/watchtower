import type {
  AssistantLocale,
  AssistantStarter,
  Permission,
  ProposalKind,
} from '@watchtower/shared';

import { evaluatePermissionRule, type PermissionRule } from '../auth/permission-check.js';
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
  // T-402, T-403
  'incident_search',
  'incident_get',
  'alert_search',
  'alert_get',
  'statuspage_status',
  'statuspage_drafts',
  'shift_context',
  'roster_view',
  // T-404, T-405: the read tools of the modules (ADR-029 section 2).
  'ops_metrics',
  'ceo_metrics',
  'performance_view',
  'conversation_search',
  'conversation_get',
  'kb_get',
  'ticket_timeline',
  'autonomy_status',
  'config_lookup',
] as const;
export type AssistantToolName = (typeof ASSISTANT_TOOLS)[number];

const STAFF_TOOLS: readonly AssistantToolName[] = [
  'search_tickets',
  'summarize_ticket',
  'explain_sla',
  'team_status',
  'kb_search',
  'investigate_run',
  // T-402, T-403: each is still held to the rule of its GET route by `toolsFor`.
  'incident_search',
  'incident_get',
  'alert_search',
  'alert_get',
  'statuspage_status',
  'statuspage_drafts',
  'shift_context',
  'roster_view',
  'ops_metrics',
  'performance_view',
  'conversation_search',
  'conversation_get',
  'kb_get',
  'ticket_timeline',
  'autonomy_status',
];

export const ROLE_TOOLS: Readonly<Record<string, readonly AssistantToolName[]>> = {
  agent: STAFF_TOOLS,
  lead: [...STAFF_TOOLS, 'team_load', 'ceo_metrics', 'config_lookup'],
  head: [...STAFF_TOOLS, 'team_load', 'ceo_metrics', 'config_lookup'],
  // Masked reader: finds, reads and investigates, does not see the team or the roster.
  dev: [
    'search_tickets',
    'summarize_ticket',
    'explain_sla',
    'kb_search',
    'investigate_run',
    'kb_get',
    'ticket_timeline',
  ],
};

/** What a tool writes to the audit as personal data read (`pii.read`, `metadata.via=assistant`; T-400 C-17). */
export const PII_KINDS = [
  'ticket',
  'conversation',
  'contact',
  'timeline',
  'shift_overview',
  'performance',
] as const;
export type PiiKind = (typeof PII_KINDS)[number];

export interface ToolAccess {
  /**
   * The GET route that serves the same data (`toolRoute`). The parity test reads the decorators of that route and fails
   * when `rule` is not what the route asks of the person, and the tool output must be within what the route returns.
   */
  readonly route: string;
  /**
   * The rule in the shape of the decorator (`all` = RequirePermission, `anyOf` = RequireAnyPermission), decided by the
   * same evaluator as the guard (`evaluatePermissionRule`). No shortcut: `ticket.read.masked` satisfies only a rule that
   * names it (T-400 C-1). A permission of the client alone (`ticket.read.org`) is left out.
   */
  readonly rule: PermissionRule;
  /** The kinds of personal data the tool reads: each entity read becomes a `pii.read` row. Empty: none. */
  readonly piiKinds: readonly PiiKind[];
}

const TICKET_READ: PermissionRule = { anyOf: ['ticket.read', 'ticket.read.masked'] };

export const TOOL_PERMISSION: Readonly<Record<AssistantToolName, ToolAccess>> = {
  search_tickets: { route: 'GET /v1/tickets', rule: TICKET_READ, piiKinds: ['ticket'] },
  summarize_ticket: { route: 'GET /v1/tickets/:id', rule: TICKET_READ, piiKinds: ['ticket'] },
  explain_sla: { route: 'GET /v1/tickets/:id', rule: TICKET_READ, piiKinds: ['ticket'] },
  team_load: { route: 'GET /v1/tickets/stats', rule: { all: ['ticket.read'] }, piiKinds: [] },
  team_status: { route: 'GET /v1/assignees', rule: { all: ['ticket.handle'] }, piiKinds: [] },
  kb_search: { route: 'GET /v1/kb/search', rule: { all: ['kb.read'] }, piiKinds: [] },
  investigate_run: {
    route: 'GET /v1/tickets/:id/tools',
    rule: { all: ['investigate.run'] },
    piiKinds: ['ticket'],
  },
  // T-402: incidents and the status page need `ticket.read` whole, so the masked developer gets none (C-1).
  incident_search: { route: 'GET /v1/incidents', rule: { all: ['ticket.read'] }, piiKinds: [] },
  incident_get: {
    route: 'GET /v1/incidents/:id',
    rule: { all: ['ticket.read'] },
    piiKinds: ['ticket', 'timeline'],
  },
  alert_search: { route: 'GET /v1/alerts', rule: { all: ['alert.read'] }, piiKinds: [] },
  alert_get: { route: 'GET /v1/alerts/:id', rule: { all: ['alert.read'] }, piiKinds: [] },
  statuspage_status: {
    route: 'GET /v1/status-page/components',
    rule: { all: ['ticket.read'] },
    piiKinds: [],
  },
  statuspage_drafts: {
    route: 'GET /v1/status-page/posts',
    rule: { all: ['ticket.read'] },
    piiKinds: [],
  },
  // T-403: the declared route is the handoff of the caller; the other sections check their own permission in the handler.
  shift_context: {
    route: 'GET /v1/handoffs/current',
    rule: { all: ['handoff.write'] },
    piiKinds: ['ticket'],
  },
  roster_view: {
    route: 'GET /v1/roster',
    rule: { anyOf: ['shift.clock', 'roster.manage'] },
    piiKinds: [],
  },
  // T-404 (reports). `performance_view` is served by the same dashboard route; the handler also asks for
  // `performance.read.own` or `.all` and ignores a userId when only `.own` is held (C-16).
  ops_metrics: {
    route: 'GET /v1/dashboard/ops',
    rule: { all: ['dashboard.ops.read'] },
    piiKinds: [],
  },
  ceo_metrics: { route: 'GET /v1/reports/ceo', rule: { all: ['ceo.view'] }, piiKinds: [] },
  performance_view: {
    route: 'GET /v1/dashboard/ops',
    rule: { all: ['dashboard.ops.read'] },
    piiKinds: ['performance'],
  },
  // T-405.
  conversation_search: {
    route: 'GET /v1/inbound/other-mail',
    rule: { all: ['inbound.read'] },
    piiKinds: ['conversation'],
  },
  conversation_get: {
    route: 'GET /v1/inbound/other-mail/:id',
    rule: { all: ['inbound.read'] },
    piiKinds: ['conversation'],
  },
  kb_get: { route: 'GET /v1/kb/articles/:id', rule: { all: ['kb.read'] }, piiKinds: [] },
  ticket_timeline: {
    route: 'GET /v1/tickets/:id/timeline',
    rule: TICKET_READ,
    piiKinds: ['ticket', 'timeline'],
  },
  autonomy_status: { route: 'GET /v1/autonomy', rule: { all: ['ticket.read'] }, piiKinds: [] },
  // The routes of an SLA policy, a queue, an intent and the workflow are `ticket.read`; an integration is
  // `integration.manage`, which the handler asks for itself.
  config_lookup: { route: 'GET /v1/sla-policies', rule: { all: ['ticket.read'] }, piiKinds: [] },
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
    evaluatePermissionRule(principal, TOOL_PERMISSION[name].rule),
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
