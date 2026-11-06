import {
  assistantContextSchema,
  assistantEntitySchema,
  type AssistantEntity,
} from '@watchtower/shared';
import { PII_KINDS } from './assistant-access.js';

/** A source read without a visible chip still needs the same pre-reply personal-data audit. */
export function trackAssistantPiiRead(
  ref: { kind: string; id: string },
  tickets: Map<string, string>,
  others: Map<string, { readonly kind: string; readonly id: string }>,
): void {
  if (ref.kind === 'ticket') tickets.set(ref.id, tickets.get(ref.id) ?? '');
  else if (ref.kind === 'handoff' || PII_KINDS.some((kind) => kind === ref.kind))
    others.set(`${ref.kind}:${ref.id}`, ref);
}

/** Extract every stable ref; re-resolution and dictionary reads happen under the current principal. */
export function conversationRefs(
  rows: readonly { context: unknown; evidence: readonly { kind: string; id: string }[] }[],
): AssistantEntity[] {
  const wanted = new Map<string, AssistantEntity>();
  const add = (candidate: unknown): void => {
    const ref = assistantEntitySchema.safeParse(candidate);
    if (ref.success) wanted.set(`${ref.data.kind}:${ref.data.ref}`, ref.data);
  };
  for (const row of rows) {
    // `readRefs` is server-only storage, intentionally absent from the public request schema.
    const stored =
      typeof row.context === 'object' && row.context !== null && 'readRefs' in row.context
        ? row.context.readRefs
        : undefined;
    if (Array.isArray(stored)) for (const ref of stored) add(ref);
    const context = assistantContextSchema.safeParse(row.context);
    if (context.success) {
      add(context.data.entity);
      if (context.data.ticket !== undefined) add({ kind: 'ticket', ref: context.data.ticket });
      for (const ref of context.data.selection?.refs ?? [])
        add({ kind: context.data.selection?.kind, ref });
    }
    for (const evidence of row.evidence)
      add({ kind: evidence.kind === 'kb' ? 'kb_article' : evidence.kind, ref: evidence.id });
  }
  return [...wanted.values()];
}
