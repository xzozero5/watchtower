import type { AssistantFact, ToolDefinition } from '@watchtower/ai';
import type { ClaimEvidenceKind, AssistantLocale, Permission } from '@watchtower/shared';
import type { z } from 'zod';

import { evaluatePermissionRule, type PermissionRule } from '../../auth/permission-check.js';
import { forbidden } from '../../auth/http-errors.js';
import type { Principal } from '../../auth/principal.js';
import type { PiiKind, AssistantToolName } from '../assistant-access.js';
import type { ReadOnlyRunner } from '../read-only.js';
import type { ModuleReadServices } from './read-services.js';

/**
 * The shared pieces of the module read tools of stage 1 (ADR-029 section 2, T-404, T-405): the limits, the fact shape
 * (`ref` and `trust`), the wrapper that makes free text data and not instruction (C-14), and what a tool file gets to
 * work with. A tool file never imports `DatabaseService`: it wraps a reader or a service the GET route already uses.
 */

/** A list a tool returns has at most this many rows (ADR-029 section 2). */
export const MAX_LIST = 20;
/** The text of a fact, after wrapping, has at most this many characters (ADR-029 section 2). */
export const MAX_FACT_TEXT = 1200;

export type FactTrust = 'system' | 'staff' | 'customer';

/** What a fact points at: the real id, from which the host builds a citation and a link (ADR-029 section 5). */
export interface FactRef {
  readonly kind: ClaimEvidenceKind;
  readonly id: string;
}

/** An `AssistantFact` that also says what it points at and who wrote its text. */
export interface ToolFact extends AssistantFact {
  readonly ref: FactRef;
  readonly trust: FactTrust;
}

const OPEN = '<untrusted_content>';
const CLOSE = '</untrusted_content>';

/**
 * Text somebody else wrote (a customer message, a KB article, a note) is data for the model, never an instruction
 * (ADR-029 section 6, C-14). The block tags inside the text lose their angle bracket so the text cannot end the block
 * and speak as the prompt. The result is no longer than `MAX_FACT_TEXT` with `prefix` and the tags counted.
 */
export function untrusted(text: string, prefix = ''): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  const safe = flat.replaceAll(
    /<(\/?\s*(?:untrusted_content|tool_results|request|ticket|evidence|report|facts)\b)/gi,
    '‹$1',
  );
  const room = Math.max(0, MAX_FACT_TEXT - prefix.length - OPEN.length - CLOSE.length);
  return `${prefix}${OPEN}${cutAtWord(safe, room)}${CLOSE}`;
}

/**
 * Cuts at a word boundary, so an address or a number is never cut in half (a cut one is no longer recognized by the
 * redactor, N4). The agent redacts first and cuts again; this is the bound the tool itself keeps.
 */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - 1);
  const head = text.slice(0, room);
  const space = head.lastIndexOf(' ');
  return `${space > room / 2 ? head.slice(0, space) : head}…`;
}

/** A plain system line (numbers, ids, keys), cut to the same bound. */
export const plain = (text: string): string => cutAtWord(text, MAX_FACT_TEXT);

export interface FactInput {
  readonly kind: ClaimEvidenceKind;
  readonly id: string;
  readonly label: string;
  readonly text: string;
  readonly trust: FactTrust;
  readonly href?: string | undefined;
  readonly mock?: boolean | undefined;
  readonly names?: readonly string[] | undefined;
}

export function toolFact(input: FactInput): ToolFact {
  return {
    kind: input.kind,
    label: cutAtWord(input.label, 200),
    ...(input.href === undefined ? {} : { href: input.href }),
    ...(input.mock === true ? { mock: true } : {}),
    text: input.text,
    ...(input.names === undefined || input.names.length === 0 ? {} : { names: input.names }),
    ref: { kind: input.kind, id: input.id },
    trust: input.trust,
  };
}

/** What a module tool is given by `buildAssistantTools`. */
export interface ModuleToolContext {
  readonly services: ModuleReadServices;
  readonly principal: Principal;
  readonly locale: AssistantLocale;
  /** `dev`: personal data masked by the reader; a tool of this file adds no identity of its own. */
  readonly masked: boolean;
  readonly now: Date;
  readonly readOnly: ReadOnlyRunner;
  /** The people of the organizations read, for the redactor of the answer (N4). */
  remember(orgIds: readonly string[]): Promise<void>;
  /** Told of each entity of personal data read, for `pii.read` with `via=assistant` (C-17). */
  onRead(kind: PiiKind, id: string, key?: string): void;
  /** `OPS-12` from the number of a ticket. */
  keyOf(number: number): string;
}

/** The second lock (ADR-029 section 2): the handler checks the rule again, so a tool called some other way still refuses. */
export function requireRule(principal: Principal, rule: PermissionRule): void {
  if (!evaluatePermissionRule(principal, rule)) throw forbidden();
}

export const holds = (principal: Principal, permission: Permission): boolean =>
  principal.permissions.has(permission);

/** The `add` of `buildAssistantTools`, which wraps a handler in the read-only scope and keeps the facts builder. */
export type AddTool = <I extends z.ZodType, O extends z.ZodType>(
  name: AssistantToolName,
  tool: Omit<ToolDefinition<I, O>, 'name' | 'readOnly'>,
  hint: string,
  toFacts: (output: z.output<O>) => readonly AssistantFact[],
) => void;

/** One tool of a file: calls `add` once. */
export type ToolRegistrar = (add: AddTool) => void;
