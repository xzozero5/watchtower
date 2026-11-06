import {
  wrapUntrusted,
  type AssistantFact,
  type FactTrust,
  type ToolDefinition,
} from '@watchtower/ai';
import type { ClaimEvidenceKind, AssistantEntityKind } from '@watchtower/shared';
import { z } from 'zod';

import type { Principal } from '../../auth/principal.js';
import type { AssistantToolName } from '../assistant-access.js';
import type { ReadOnlyRunner } from '../read-only.js';

/** `[ASSUMED]` (ADR-029 section 2): a list tool returns at most this many rows. */
export const MAX_LIST = 20;
/** ADR-029 section 2: the text of a fact, tags included, is at most this long. */
export const MAX_FACT_TEXT = 1200;

/** `limit` of every list tool: 1 to 20, ten when the model does not say. */
export const limitSchema = z.number().int().min(1).max(MAX_LIST).default(10);

/** Registers one tool of a module: the same shape `buildAssistantTools` uses for its own tools. */
export type AddTool = <I extends z.ZodType, O extends z.ZodType>(
  name: AssistantToolName,
  tool: Omit<ToolDefinition<I, O>, 'name' | 'readOnly'>,
  hint: string,
  toFacts: (output: z.output<O>) => readonly AssistantFact[],
) => void;

/** What a module's tools need from the request and from `buildAssistantTools`. */
export interface OpsToolKit {
  readonly principal: Principal;
  readonly now: Date;
  readonly readOnly: ReadOnlyRunner;
  /** Gives the people of these organizations to the redactor of the answer (N4). */
  remember(orgIds: readonly string[]): Promise<void>;
  /** Told of each ticket whose content a tool read (the audit of personal data read). */
  readonly onRead?: ((ticket: { readonly id: string; readonly key: string }) => void) | undefined;
  readonly onReadRef?: ((ref: { kind: AssistantEntityKind; id: string }) => void) | undefined;
  readonly add: AddTool;
}

/** A string cut to `max` characters, the cut marked with an ellipsis. Whitespace is squashed first. */
export function cut(text: string, max: number): string {
  const squashed = text.replaceAll(/\s+/g, ' ').trim();
  return squashed.length <= max ? squashed : `${squashed.slice(0, max - 1)}…`;
}

export const cutNullable = (text: string | null, max: number): string | null =>
  text === null ? null : cut(text, max);

export interface FactParts {
  readonly kind: ClaimEvidenceKind;
  readonly id: string;
  readonly label: string;
  /** Our own words: ids, enumerations, counts, times. */
  readonly system: string;
  /** Free text somebody else wrote. It is wrapped as untrusted content (C-14) and shares what room `system` leaves. */
  readonly free?: readonly (string | null | undefined)[];
  readonly trust?: Exclude<FactTrust, 'system'>;
  readonly names?: readonly string[];
  readonly href?: string;
}

/**
 * One fact with its `ref` and its `trust`. The text is `system` and then each piece of free text in
 * `<untrusted_content>` (`wrapUntrusted`), the whole at most 1 200 characters (the agent redacts before it cuts:
 * this is the first of two caps, so a long field can never crowd out the rest).
 */
export function makeFact(parts: FactParts): AssistantFact {
  const system = cut(parts.system, 500);
  const free = (parts.free ?? []).filter(
    (piece): piece is string => typeof piece === 'string' && piece.trim() !== '',
  );
  let text = system;
  if (free.length > 0) {
    const room = Math.floor((MAX_FACT_TEXT - system.length - free.length) / free.length);
    text = `${system} ${free.map((piece) => wrapUntrusted(piece, room)).join(' ')}`;
  }
  return {
    kind: parts.kind,
    label: cut(parts.label, 200),
    ...(parts.href === undefined ? {} : { href: parts.href }),
    text: text.length <= MAX_FACT_TEXT ? text : `${text.slice(0, MAX_FACT_TEXT - 1)}…`,
    ref: { kind: parts.kind, id: parts.id },
    trust: free.length === 0 ? 'system' : (parts.trust ?? 'staff'),
    ...(parts.names === undefined || parts.names.length === 0 ? {} : { names: [...parts.names] }),
  };
}
