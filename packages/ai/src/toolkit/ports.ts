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

// --- Fixtures for the stubs (GCP Logs, BigQuery, repo) in mock mode -------------------------------

export const stubLogEntrySchema = z.object({
  timestamp: z.string().max(40),
  severity: z.string().max(20),
  service: z.string().max(100),
  message: z.string().max(600),
});
export type StubLogEntry = z.infer<typeof stubLogEntrySchema>;

export const stubFixturesSchema = z.object({
  gcpLogs: z
    .array(
      z.object({
        /** The scenario answers when the query contains any of these words (case-insensitive). */
        keywords: z.array(z.string().min(1).max(60)).min(1),
        entries: z.array(stubLogEntrySchema).max(50),
      }),
    )
    .default([]),
  bigquery: z
    .array(
      z.object({
        /** Name of a saved query template. */
        template: z.string().min(1).max(100),
        columns: z.array(z.string().max(60)).max(20),
        rows: z
          .array(z.array(z.union([z.string().max(200), z.number(), z.null()])).max(20))
          .max(100),
      }),
    )
    .default([]),
  repoChanges: z
    .array(
      z.object({
        service: z.string().min(1).max(100),
        changes: z
          .array(
            z.object({
              kind: z.enum(['commit', 'pull_request', 'release', 'deploy']),
              ref: z.string().max(100),
              title: z.string().max(300),
              at: z.string().max(40),
              url: z.string().max(500).optional(),
            }),
          )
          .max(50),
      }),
    )
    .default([]),
});
export type StubFixtures = z.infer<typeof stubFixturesSchema>;
