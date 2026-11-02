import { randomUUID } from 'node:crypto';

import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createRedactor, hmacJson } from '@watchtower/ai';
import {
  ConnectorError,
  ConnectorRateLimitedError,
  formatLogLine,
  formatRows,
  parseLogFilter,
  runDataTemplate,
  runLogsTemplate,
  templatePlaceholders,
  type SqlValue,
} from '@watchtower/connectors';
import { schema, type Database } from '@watchtower/db';
import {
  createHumanToolLedger,
  getToolTemplate,
  templatesForTicket,
  type HumanToolLedger,
} from '@watchtower/domain';
import {
  DATA_RUN_MAX_ROWS,
  DATA_RUN_TIMEOUT_MS,
  budgetProjectFor,
  RATE_TOOL_NAMES,
  TOOL_AUTO_PARAMS,
  TOOLS_AUDIT_ACTIONS,
  type AdhocData,
  type AdhocLogs,
  type EvidenceCard,
  type RunTool,
  type TicketTools,
} from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { and, desc, eq, sql } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service.js';
import {
  badRequest,
  notFound,
  RateLimitedError,
  toolFailed,
  toolNotHardened,
  toolNotConnected,
} from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { TicketReader } from '../tickets/ticket-reader.js';
import { clientIsMock, TOOL_CLIENTS, type ToolClients } from './tool-clients.js';

type CardRow = typeof schema.evidenceCard.$inferSelect;

export function toEvidenceCard(row: CardRow): EvidenceCard {
  return {
    id: row.id,
    ticketId: row.ticketId,
    incidentId: row.incidentId,
    kind: row.kind as EvidenceCard['kind'],
    templateId: row.templateId,
    templateName: row.templateName,
    title: row.title,
    summary: row.summary,
    excerpt: row.excerpt,
    resultCount: row.resultCount,
    truncated: row.truncated,
    maskedColumns: row.maskedColumns,
    windowFrom: row.windowFrom?.toISOString() ?? null,
    windowTo: row.windowTo?.toISOString() ?? null,
    mock: row.mock,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/** What the card is pinned to. */
export type Subject =
  | {
      readonly kind: 'ticket';
      readonly ticketId: string;
      readonly orgId: string;
      readonly intentKey: string | null;
      /** Names of people of the organization, so the redactor knows them (N4). */
      readonly orgNames: () => Promise<string[]>;
    }
  | { readonly kind: 'incident'; readonly incidentId: string };

const EXCERPT_LOG_LINES = 20;
const EXCERPT_ROWS = 25;
const EXCERPT_CHARS = 4000;
const MAX_NAMES = 200;

/** A result as the card keeps it, before redaction. */
interface Finding {
  readonly kind: 'logs' | 'data';
  readonly title: string;
  readonly summary: string;
  /** Text of the result, as the provider returned it; redacted before it is stored. */
  readonly text: string;
  /** The whole result as data, for the keyed hash only. */
  readonly raw: unknown;
  readonly count: number;
  readonly truncated: boolean;
  readonly masked: readonly string[];
  readonly from: Date | null;
  readonly to: Date | null;
  readonly mock: boolean;
}

interface Attempt {
  readonly templateId: string | null;
  readonly templateName: string;
  /** Goes into the keyed hash of the parameters. Never stored. */
  readonly paramsForHash: unknown;
  readonly tool: string;
  readonly mock: boolean;
  readonly run: (signal: AbortSignal) => Promise<Finding>;
}

function translateConnectorError(error: unknown): never {
  if (error instanceof ConnectorRateLimitedError) {
    // The provider itself said 429: tell the person to wait as long as it asked.
    throw new RateLimitedError(Math.max(1, Math.ceil(error.retryAfterMs / 1000)));
  }
  if (error instanceof ConnectorError) {
    switch (error.code) {
      case 'invalid_query':
        throw badRequest(error.message);
      case 'timeout':
        throw toolFailed(true);
      case 'not_connected':
        throw toolNotConnected();
      default:
        throw toolFailed(false);
    }
  }
  throw error;
}

/**
 * A person's run of a read-only tool (T-203d, AC-5): a saved template on a ticket or an incident, or
 * a filter or statement of their own (`investigate.adhoc`). Each run
 *  1. takes a unit from the shared rate window (and is refused with 429 when the budget is used),
 *  2. is a row in `tool_execution` (the input only as a keyed hash, N2),
 *  3. is read through the connector, which is read-only by type,
 *  4. leaves an evidence card whose excerpt went through the redactor (N4), and an audit row.
 */
@Injectable()
export class ToolRunner implements OnModuleDestroy {
  private readonly hashKey: string;
  private readonly ledger: HumanToolLedger;
  private readonly project: string;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(TOOL_CLIENTS) private readonly clients: ToolClients,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TicketReader) private readonly tickets: TicketReader,
    @Inject(APP_CONFIG) config: ApiConfig,
  ) {
    this.hashKey = deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.aiInputHash).toString('hex');
    this.project = budgetProjectFor(config.GCP_PROJECT_ID);
    this.ledger = createHumanToolLedger({ db: database.db, project: this.project });
  }

  async onModuleDestroy(): Promise<void> {
    await this.clients.close?.();
  }

  // --- subjects ---------------------------------------------------------------------------

  async ticketSubject(ref: string, principal: Principal): Promise<Subject> {
    const view = await this.tickets.viewRow(ref, principal);
    const orgId = view.t.orgId;
    return {
      kind: 'ticket',
      ticketId: view.t.id,
      orgId,
      intentKey: view.intentKey,
      orgNames: async () => {
        const rows = await this.database.db
          .select({ name: schema.contact.name })
          .from(schema.contact)
          .where(eq(schema.contact.orgId, orgId))
          .limit(MAX_NAMES);
        return rows.map((row) => row.name);
      },
    };
  }

  async incidentSubject(id: string): Promise<Subject> {
    const [row] = await this.database.db
      .select({ id: schema.incident.id })
      .from(schema.incident)
      .where(eq(schema.incident.id, id))
      .limit(1);
    if (row === undefined) throw notFound('No such incident');
    return { kind: 'incident', incidentId: row.id };
  }

  // --- the buttons ------------------------------------------------------------------------

  async buttons(subject: Extract<Subject, { kind: 'ticket' }>): Promise<TicketTools> {
    const templates = await templatesForTicket(this.database.db, subject.intentKey);
    return {
      intentKey: subject.intentKey,
      buttons: templates.map((template) => {
        const kind = template.kind as 'logs' | 'data';
        const connected = kind === 'logs' ? this.clients.logs !== undefined : this.clients.data !== undefined;
        return {
          templateId: template.id,
          kind,
          name: template.name,
          title: template.title,
          inputParams: templatePlaceholders(template.body).filter(
            (name) => !(TOOL_AUTO_PARAMS as readonly string[]).includes(name),
          ),
          connected,
          mock: kind === 'logs' ? (this.clients.logs ? clientIsMock(this.clients.logs) : true) : (this.clients.dataMock ?? true),
        };
      }),
    };
  }

  // --- runs -------------------------------------------------------------------------------

  /** Runs a saved template for a ticket or an incident and pins what it found. */
  async runTemplate(subject: Subject, body: RunTool, principal: Principal): Promise<EvidenceCard> {
    const template = await getToolTemplate(this.database.db, body.templateId);
    if (template === null || !template.active) throw notFound('No such template');
    if (
      subject.kind === 'ticket' &&
      template.intentKey !== null &&
      template.intentKey !== subject.intentKey
    ) {
      throw badRequest('That template belongs to another intent');
    }
    const kind = template.kind as 'logs' | 'data';
    const params = this.resolveParams(subject, template.body, body.params);
    const windowMinutes = body.windowMinutes;
    const attempt: Attempt = {
      templateId: template.id,
      templateName: template.name,
      paramsForHash: { template: template.id, params, windowMinutes },
      tool: kind === 'logs' ? RATE_TOOL_NAMES.logs : RATE_TOOL_NAMES.data,
      mock: this.isMock(kind),
      run: async (signal) => {
        if (kind === 'logs') {
          const logs = this.requireLogs();
          const result = await runLogsTemplate(logs, {
            body: template.body,
            params,
            window: { now: new Date(), windowMinutes },
            limit: 50,
            signal,
          });
          return {
            kind: 'logs',
            title: `Logs: ${template.title}`,
            summary: `${String(result.entries.length)} log entries from ${result.from.toISOString()} to ${result.to.toISOString()}${result.hasMore ? ' (more exist)' : ''}`,
            text: result.entries.slice(0, EXCERPT_LOG_LINES).map(formatLogLine).join('\n'),
            raw: result.entries,
            count: result.entries.length,
            truncated: result.hasMore,
            masked: [],
            from: result.from,
            to: result.to,
            mock: clientIsMock(logs),
          };
        }
        const data = this.requireData(template.allowedColumns);
        const result = await runDataTemplate(data, {
          name: template.name,
          body: template.body,
          params,
          maxRows: DATA_RUN_MAX_ROWS,
          timeoutMs: DATA_RUN_TIMEOUT_MS,
          signal,
        });
        return this.dataFinding(`Data: ${template.title}`, result, null, null);
      },
    };
    return this.execute(subject, attempt, principal, TOOLS_AUDIT_ACTIONS.toolRun);
  }

  async runAdhocLogs(body: AdhocLogs, principal: Principal): Promise<EvidenceCard> {
    const subject = await this.adhocSubject(body, principal);
    const logs = this.requireLogs();
    // A filter that does not parse is the person's mistake, not a call against the quota.
    try {
      parseLogFilter(body.filter);
    } catch (error) {
      translateConnectorError(error);
    }
    const attempt: Attempt = {
      templateId: null,
      templateName: 'adhoc',
      paramsForHash: { filter: body.filter, windowMinutes: body.windowMinutes, limit: body.limit },
      tool: RATE_TOOL_NAMES.logs,
      mock: clientIsMock(logs),
      run: async (signal) => {
        const to = new Date();
        const from = new Date(to.getTime() - body.windowMinutes * 60_000);
        const page = await logs.listEntries({
          filter: body.filter,
          from,
          to,
          pageSize: body.limit,
          order: 'desc',
          signal,
        });
        return {
          kind: 'logs',
          title: 'Logs: your filter',
          summary: `${String(page.entries.length)} log entries from ${from.toISOString()} to ${to.toISOString()}${page.nextPageToken === null ? '' : ' (more exist)'}`,
          text: page.entries.slice(0, EXCERPT_LOG_LINES).map(formatLogLine).join('\n'),
          raw: page.entries,
          count: page.entries.length,
          truncated: page.nextPageToken !== null,
          masked: [],
          from,
          to,
          mock: clientIsMock(logs),
        };
      },
    };
    return this.execute(subject, attempt, principal, TOOLS_AUDIT_ACTIONS.toolAdhoc);
  }

  async runAdhocData(body: AdhocData, principal: Principal): Promise<EvidenceCard> {
    const subject = await this.adhocSubject(body, principal);
    const data = this.requireData([]);
    // A statement of one's own is only as safe as the database role behind it. A product database whose
    // login can still take locks, write WAL or sleep (the revokes of product-mock.grants.sql are not all
    // in place) is used through saved templates only.
    if ((await this.hardeningProblems()).length > 0) throw toolNotHardened();
    const params: SqlValue[] = [...body.params];
    const attempt: Attempt = {
      templateId: null,
      templateName: 'adhoc',
      paramsForHash: { sql: body.sql, params, maxRows: body.maxRows },
      tool: RATE_TOOL_NAMES.data,
      mock: this.clients.dataMock ?? true,
      run: async (signal) => {
        const result = await data.query({
          label: 'adhoc',
          sql: body.sql,
          params,
          maxRows: Math.min(body.maxRows, DATA_RUN_MAX_ROWS * 5),
          timeoutMs: DATA_RUN_TIMEOUT_MS,
          signal,
        });
        return this.dataFinding('Data: your statement', result, null, null);
      },
    };
    return this.execute(subject, attempt, principal, TOOLS_AUDIT_ACTIONS.toolAdhoc);
  }

  // --- cards ------------------------------------------------------------------------------

  async listCards(subject: Subject): Promise<EvidenceCard[]> {
    const where =
      subject.kind === 'ticket'
        ? eq(schema.evidenceCard.ticketId, subject.ticketId)
        : eq(schema.evidenceCard.incidentId, subject.incidentId);
    const rows = await this.database.db
      .select()
      .from(schema.evidenceCard)
      .where(where)
      .orderBy(desc(schema.evidenceCard.createdAt), desc(schema.evidenceCard.id))
      .limit(100);
    return rows.map(toEvidenceCard);
  }

  async removeCard(subject: Subject, cardId: string, principal: Principal): Promise<void> {
    const where =
      subject.kind === 'ticket'
        ? and(eq(schema.evidenceCard.id, cardId), eq(schema.evidenceCard.ticketId, subject.ticketId))
        : and(eq(schema.evidenceCard.id, cardId), eq(schema.evidenceCard.incidentId, subject.incidentId));
    await this.uow.run(async ({ tx }) => {
      const [removed] = await tx
        .delete(schema.evidenceCard)
        .where(where)
        .returning({ id: schema.evidenceCard.id, kind: schema.evidenceCard.kind });
      if (removed === undefined) throw notFound('No such evidence card');
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'user', id: principal.userId },
        action: TOOLS_AUDIT_ACTIONS.evidenceDelete,
        targetType: 'evidence_card',
        targetId: removed.id,
        metadata: { kind: removed.kind, subject: subject.kind },
      });
    });
  }

  // --- internals --------------------------------------------------------------------------

  private async adhocSubject(
    body: { readonly ticketId?: string | undefined; readonly incidentId?: string | undefined },
    principal: Principal,
  ): Promise<Subject> {
    if (body.ticketId !== undefined) return this.ticketSubject(body.ticketId, principal);
    if (body.incidentId !== undefined) return this.incidentSubject(body.incidentId);
    throw badRequest('Say which ticket or incident the result is for');
  }

  #hardening:
    | { check: () => Promise<readonly string[]>; at: number; problems: readonly string[] }
    | undefined;

  /** What the data login can do that it should not; looked at once a minute at most. */
  private async hardeningProblems(): Promise<readonly string[]> {
    const check = this.clients.dataHardening;
    if (check === undefined) return [];
    if (
      this.#hardening?.check === check &&
      Date.now() - this.#hardening.at < 60_000
    ) {
      return this.#hardening.problems;
    }
    let problems: readonly string[];
    try {
      problems = await check();
    } catch {
      // Cannot tell: treat it as not hardened.
      problems = ['the check failed'];
    }
    this.#hardening = { check, at: Date.now(), problems };
    return problems;
  }

  private isMock(kind: 'logs' | 'data'): boolean {
    if (kind === 'logs') return this.clients.logs === undefined ? true : clientIsMock(this.clients.logs);
    return this.clients.dataMock ?? true;
  }

  private requireLogs() {
    if (this.clients.logs === undefined) throw toolNotConnected();
    return this.clients.logs;
  }

  private requireData(extraColumns: readonly string[]) {
    if (this.clients.data === undefined) throw toolNotConnected();
    return this.clients.data(extraColumns);
  }

  /** The ticket fills `org_id` and `ticket_id`; the caller gives the rest, and nothing else. */
  private resolveParams(
    subject: Subject,
    body: string,
    given: Readonly<Record<string, string>>,
  ): Record<string, string> {
    const names = templatePlaceholders(body);
    const auto: Record<string, string> =
      subject.kind === 'ticket' ? { org_id: subject.orgId, ticket_id: subject.ticketId } : {};
    const out: Record<string, string> = {};
    for (const name of names) {
      const fromTicket = auto[name];
      if (fromTicket !== undefined) {
        if (name in given) throw badRequest(`${name} is filled from the ticket and cannot be given`);
        out[name] = fromTicket;
        continue;
      }
      const value = given[name];
      if (value === undefined) throw badRequest(`Missing parameter: ${name}`);
      out[name] = value;
    }
    for (const name of Object.keys(given)) {
      if (!names.includes(name)) throw badRequest(`Unknown parameter: ${name}`);
    }
    return out;
  }

  private dataFinding(
    title: string,
    result: Awaited<ReturnType<typeof runDataTemplate>>,
    from: Date | null,
    to: Date | null,
  ): Finding {
    const hidden = result.masked.length;
    return {
      kind: 'data',
      title,
      summary: `${String(result.rows.length)} rows, ${String(result.columns.length)} columns${result.truncated ? ' (more exist)' : ''}${hidden === 0 ? '' : `, ${String(hidden)} hidden`}`,
      text: formatRows(result, EXCERPT_ROWS),
      raw: { columns: result.columns, rows: result.rows },
      count: result.rows.length,
      truncated: result.truncated,
      masked: result.masked,
      from,
      to,
      mock: this.clients.dataMock ?? true,
    };
  }

  private async execute(
    subject: Subject,
    attempt: Attempt,
    principal: Principal,
    action: string,
  ): Promise<EvidenceCard> {
    const runKey = randomUUID();
    const decision = await this.ledger.begin({
      runKey,
      ticketId: subject.kind === 'ticket' ? subject.ticketId : null,
      agent: 'human',
      tool: attempt.tool,
      inputHash: hmacJson(this.hashKey, attempt.paramsForHash),
      mock: attempt.mock,
      actor: 'human',
      personId: principal.userId,
    });
    if (!decision.allowed) {
      throw new RateLimitedError(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
    }
    const started = Date.now();
    let finding: Finding;
    try {
      finding = await attempt.run(AbortSignal.timeout(DATA_RUN_TIMEOUT_MS * 3));
    } catch (error) {
      await this.ledger.finish(decision.id, {
        status: 'error',
        errorCode: error instanceof Error ? error.name : 'UnknownError',
        latencyMs: Date.now() - started,
        resultCount: null,
      });
      translateConnectorError(error);
    }
    await this.ledger.finish(decision.id, {
      status: 'ok',
      errorCode: null,
      latencyMs: Date.now() - started,
      resultCount: finding.count,
    });

    // N4: the excerpt is stored with personal data replaced by placeholders.
    const names = subject.kind === 'ticket' ? await subject.orgNames() : [];
    const session = createRedactor({ names: () => names }).session({
      scope: subject.kind === 'ticket' ? subject.ticketId : subject.incidentId,
    });
    const excerpt = session
      .redactToolOutput(attempt.tool, finding.text.slice(0, EXCERPT_CHARS * 2))
      .slice(0, EXCERPT_CHARS);

    const row = await this.uow.run(async ({ tx }) => {
      const [created] = await tx
        .insert(schema.evidenceCard)
        .values({
          ticketId: subject.kind === 'ticket' ? subject.ticketId : null,
          incidentId: subject.kind === 'incident' ? subject.incidentId : null,
          kind: finding.kind,
          templateId: attempt.templateId,
          templateName: attempt.templateName,
          title: finding.title,
          summary: finding.summary,
          excerpt,
          resultCount: finding.count,
          truncated: finding.truncated,
          maskedColumns: [...finding.masked],
          windowFrom: finding.from,
          windowTo: finding.to,
          paramsHash: hmacJson(this.hashKey, attempt.paramsForHash),
          resultHash: hmacJson(this.hashKey, finding.raw),
          mock: finding.mock,
          runKey,
          createdBy: principal.userId,
          createdAt: sql`clock_timestamp()`,
        })
        .returning();
      if (created === undefined) throw new Error('evidence_card insert returned no row');
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'user', id: principal.userId },
        action,
        targetType: 'evidence_card',
        targetId: created.id,
        // Ids, enumerations and counts only: never the filter, the statement, a parameter or a result.
        metadata: {
          kind: finding.kind,
          template: attempt.templateName,
          subject: subject.kind,
          subjectId: subject.kind === 'ticket' ? subject.ticketId : subject.incidentId,
          resultCount: finding.count,
          mock: finding.mock,
          runKey,
        },
      });
      return created;
    });
    return toEvidenceCard(row);
  }
}
