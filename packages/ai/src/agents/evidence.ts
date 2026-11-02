import { neutralizeTags } from './leak-check.js';
import type { AiEvidence } from '@watchtower/shared';

import { joinRedacted, type RedactedText } from '../redaction/redacted-text.js';
import type { RedactionSession } from '../redaction/redactor.js';
import {
  bigqueryOutput,
  gcpLogsOutput,
  kbSearchOutput,
  orgContextOutput,
  repoChangesOutput,
  similarTicketsOutput,
  TOOL_NAMES,
} from '../toolkit/tools.js';

/** An evidence card plus what the drafter needs to know about where it came from. */
export interface InvestigationEvidence extends AiEvidence {
  readonly tool: string;
  /** Written for customers (a customer-visible KB article). Only this kind may support a claim to an unverified contact. */
  readonly customerSafe: boolean;
  /** The tool answered from a fixture (N5). */
  readonly mock: boolean;
}

/** A card before it passes the redactor: raw tool text. Never leaves this module unprotected. */
interface RawEvidence {
  readonly kind: AiEvidence['kind'];
  readonly tool: string;
  readonly title: string;
  readonly snippet: string;
  readonly confidence: number;
  readonly href?: string;
  readonly customerSafe: boolean;
  readonly mock: boolean;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Mock logs and rows carry no confidence of their own: a fixture is an example, not a measurement. A real system's rows are facts read, but still not a diagnosis. */
const MOCK_CONFIDENCE = 0.3;
const LIVE_CONFIDENCE = 0.6;

/**
 * Turns the (already validated) output of a tool into evidence cards, one per hit or one summary
 * card for a tool that answers with rows. Unknown tools produce none.
 */
export function rawEvidenceFrom(tool: string, output: unknown): RawEvidence[] {
  switch (tool) {
    case TOOL_NAMES.kbSearch:
      return kbSearchOutput.parse(output).items.map((hit) => ({
        kind: 'kb' as const,
        tool,
        title: cut(hit.section === '' ? hit.title : `${hit.title} - ${hit.section}`, 300),
        snippet: cut(hit.snippet, 1000),
        confidence: clamp01(hit.score),
        href: hit.href,
        customerSafe: hit.customerVisible,
        mock: false,
      }));
    case TOOL_NAMES.similarTickets:
      return similarTicketsOutput.parse(output).items.map((ticket) => ({
        kind: 'ticket' as const,
        tool,
        title: cut(`${ticket.key} ${ticket.subject}`, 300),
        snippet: cut(
          `${ticket.status}${ticket.sameOrg ? ', same organization' : ''}. ${ticket.snippet}`,
          1000,
        ),
        confidence: clamp01(ticket.similarity),
        href: ticket.href,
        customerSafe: false,
        mock: false,
      }));
    case TOOL_NAMES.orgContext:
      return orgContextOutput.parse(output).items.map((org) => ({
        kind: 'data' as const,
        tool,
        title: 'Organization',
        snippet: cut(
          `${org.orgName} (${org.tier}, ${org.status}): ${String(org.openTickets)} open tickets, ${String(org.ticketsLast30Days)} in the last 30 days.`,
          1000,
        ),
        // A fact read straight from the system of record.
        confidence: 1,
        href: org.href,
        customerSafe: false,
        mock: false,
      }));
    case TOOL_NAMES.gcpLogs: {
      const parsed = gcpLogsOutput.parse(output);
      if (parsed.items.length === 0) return [];
      const lines = parsed.items
        .slice(0, 6)
        .map((entry) => `${entry.severity} ${entry.service}: ${entry.message}`);
      return [
        {
          kind: 'log' as const,
          tool,
          title: `Logs: ${String(parsed.items.length)} entries${parsed.mock ? ' (mock data)' : ''}`,
          snippet: cut(lines.join('\n'), 1000),
          confidence: parsed.mock ? MOCK_CONFIDENCE : LIVE_CONFIDENCE,
          customerSafe: false,
          mock: parsed.mock,
        },
      ];
    }
    case TOOL_NAMES.bigquery: {
      const parsed = bigqueryOutput.parse(output);
      if (parsed.items.length === 0) return [];
      const rows = parsed.items
        .slice(0, 5)
        .map((row) => row.map((cell) => String(cell ?? '')).join(' | '));
      return [
        {
          kind: 'data' as const,
          tool,
          title: `Query: ${String(parsed.items.length)} rows${parsed.mock ? ' (mock data)' : ''}`,
          snippet: cut([parsed.columns.join(' | '), ...rows].join('\n'), 1000),
          confidence: parsed.mock ? MOCK_CONFIDENCE : LIVE_CONFIDENCE,
          customerSafe: false,
          mock: parsed.mock,
        },
      ];
    }
    case TOOL_NAMES.repoChanges: {
      const parsed = repoChangesOutput.parse(output);
      if (parsed.items.length === 0) return [];
      const lines = parsed.items
        .slice(0, 6)
        .map((change) => `${change.kind} ${change.ref} ${change.at}: ${change.title}`);
      return [
        {
          kind: 'repo' as const,
          tool,
          title: `Changes: ${String(parsed.items.length)}${parsed.mock ? ' (mock data)' : ''}`,
          snippet: cut(lines.join('\n'), 1000),
          confidence: parsed.mock ? MOCK_CONFIDENCE : LIVE_CONFIDENCE,
          customerSafe: false,
          mock: parsed.mock,
        },
      ];
    }
    default:
      return [];
  }
}

/** An evidence card in the two forms that matter: for the model, and for the person. */
export interface ProtectedEvidence {
  readonly card: InvestigationEvidence;
  /** The line the model reads. Every character of tool text in it went through `redactToolOutput`. */
  readonly forModel: RedactedText;
}

/**
 * Passes tool text through the session's `redactToolOutput` (N4). The card a person sees is the
 * redacted text restored for the `staff` audience: the ticket's own details and dictionary names come back, anything
 * that belongs to somebody else (another customer's ticket, a log line) stays a placeholder.
 */
export function protectEvidence(
  session: RedactionSession,
  raw: readonly RawEvidence[],
  firstId: number,
): ProtectedEvidence[] {
  return raw.map((item, index) => {
    const id = `ev-${String(firstId + index)}`;
    const title = session.redactToolOutput(item.tool, neutralizeTags(item.title));
    const snippet = session.redactToolOutput(item.tool, neutralizeTags(item.snippet));
    const show = (text: RedactedText): string => session.restore(text, 'staff').text;
    const flags = [item.mock ? 'mock data' : null, item.customerSafe ? 'customer-safe' : null]
      .filter((flag) => flag !== null)
      .join(', ');
    return {
      card: {
        id,
        kind: item.kind,
        title: show(title),
        snippet: show(snippet),
        confidence: item.confidence,
        ...(item.href === undefined ? {} : { href: item.href }),
        tool: item.tool,
        customerSafe: item.customerSafe,
        mock: item.mock,
      },
      forModel: joinRedacted(
        [
          session.redact(`[${id}] ${item.kind}${flags === '' ? '' : ` (${flags})`}:`),
          title,
          snippet,
        ],
        ' ',
      ),
    };
  });
}
