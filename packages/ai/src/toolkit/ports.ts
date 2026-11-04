import { z } from 'zod';

/**
 * What the real tools need from the outside world, as ports (ADR-002: `packages/ai` knows no DB and
 * no HTTP). `apps/worker` implements them over the read-only role and the knowledge base search; a
 * test implements them with arrays. Every port is read-only by construction: there is no method that
 * writes.
 */

export const kbHitSchema = z.object({
  articleId: z.string().min(1).max(100),
  slug: z.string().min(1).max(200),
  title: z.string().max(300),
  section: z.string().max(300),
  snippet: z.string().max(1200),
  /** 0 to 1: rank score scaled to the best hit of the query. */
  score: z.number().min(0).max(1),
  kind: z.string().max(40),
  lang: z.string().max(10),
  /** The article is written for customers. Only such an article may support a claim to an unverified contact. */
  customerVisible: z.boolean(),
  /** The article is the runbook of the ticket's intent. */
  isRunbook: z.boolean(),
  /** Path inside Watchtower, for the evidence card. */
  href: z.string().max(500),
  /**
   * The rank came from mock embeddings, so it says nothing about how well the article fits (N5): the
   * card is labelled `Demo` and the web shows no number.
   */
  mock: z.boolean().optional(),
});
export type KbHit = z.infer<typeof kbHitSchema>;

export interface KbSearchPort {
  search(input: {
    readonly query: string;
    readonly limit: number;
    /** The scope intent, so the port can put the runbook of that intent first. */
    readonly intentKey: string | null;
    /** The ticket the run is about, so the port can leave out what is not for its organization. */
    readonly ticketId: string | null;
    readonly signal?: AbortSignal | undefined;
  }): Promise<readonly KbHit[]>;
}

export const similarTicketSchema = z.object({
  id: z.string().min(1).max(100),
  key: z.string().max(40),
  subject: z.string().max(300),
  intentKey: z.string().max(100).nullable(),
  status: z.string().max(40),
  /** The first customer message, cut short. Staff-only content: it goes through the redactor like any tool output. */
  snippet: z.string().max(600),
  /** 0 to 1. */
  similarity: z.number().min(0).max(1),
  sameOrg: z.boolean(),
  href: z.string().max(500),
});
export type SimilarTicket = z.infer<typeof similarTicketSchema>;

export interface SimilarTicketsPort {
  find(input: {
    readonly ticketId: string;
    readonly query: string;
    readonly limit: number;
    readonly signal?: AbortSignal | undefined;
  }): Promise<readonly SimilarTicket[]>;
}

export const orgContextSchema = z.object({
  orgName: z.string().max(300),
  tier: z.string().max(60),
  status: z.string().max(40),
  openTickets: z.number().int().min(0),
  ticketsLast30Days: z.number().int().min(0),
  href: z.string().max(500),
});
export type OrgContext = z.infer<typeof orgContextSchema>;

export interface OrgContextPort {
  /** The organization of the ticket. The caller names the ticket; there is no way to ask for another organization. */
  get(input: {
    readonly ticketId: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<OrgContext | null>;
}

// --- The systems outside Watchtower: GCP Logs, product data, repository (T-203d) ---------------------
//
// These ports replace the fixture stubs of T-108. `apps/worker` implements them over the read-only
// clients of `@watchtower/connectors` (a fake in mock mode, a real adapter after T-208) and over the
// saved templates of the intent; `packages/ai` knows neither. What reaches a port is only what the
// run owns (the ticket, its scope intent), never text a model or a customer wrote: the model chooses
// no filter and no statement (ADR-013). Every port is read-only by construction.

export const toolLogEntrySchema = z.object({
  timestamp: z.string().max(40),
  severity: z.string().max(20),
  service: z.string().max(100),
  message: z.string().max(600),
});
export type ToolLogEntry = z.infer<typeof toolLogEntrySchema>;

export const toolRepoChangeSchema = z.object({
  kind: z.enum(['commit', 'pull_request', 'release', 'deploy']),
  ref: z.string().max(100),
  title: z.string().max(300),
  at: z.string().max(40),
  url: z.string().max(500).optional(),
});
export type ToolRepoChange = z.infer<typeof toolRepoChangeSchema>;

export const toolDataCellSchema = z.union([z.string().max(200), z.number(), z.null()]);
export type ToolDataCell = z.infer<typeof toolDataCellSchema>;

/** Log lines of the ticket's organization, from the log template of the scope intent. */
export interface LogsToolPort {
  /** True when the answer comes from a fake or a sandbox: the card says "(mock data)". */
  readonly mock: boolean;
  run(input: {
    readonly windowMinutes: number;
    readonly limit: number;
    /** A procedure step named this template of the scope intent (T-303f); absent: the first one the AI may run. */
    readonly template?: string | undefined;
    /** The scope intent: the port finds its template. Null: there is none and the port answers with a note. */
    readonly intentKey: string | null;
    readonly ticketId: string | null;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{ readonly items: readonly ToolLogEntry[]; readonly note?: string | undefined }>;
}

/** Rows of the data template of the scope intent, behind the read-only guardrails. */
export interface DataToolPort {
  readonly mock: boolean;
  run(input: {
    readonly limit: number;
    /** See `LogsToolPort`. */
    readonly template?: string | undefined;
    readonly intentKey: string | null;
    readonly ticketId: string | null;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{
    readonly columns: readonly string[];
    readonly items: readonly (readonly ToolDataCell[])[];
    readonly note?: string | undefined;
  }>;
}

/** Commits, merged pull requests, releases and deploys of a service of the catalog. */
export interface RepoToolPort {
  readonly mock: boolean;
  run(input: {
    readonly service: string;
    readonly windowHours: number;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{ readonly items: readonly ToolRepoChange[]; readonly note?: string | undefined }>;
}

/** The three systems. A missing one means that tool is not registered: no run can call it. */
export interface SystemToolPorts {
  readonly logs?: LogsToolPort | undefined;
  readonly data?: DataToolPort | undefined;
  readonly repo?: RepoToolPort | undefined;
}
