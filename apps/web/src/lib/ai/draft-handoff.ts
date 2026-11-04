/**
 * An AI draft on its way from the draft card to the email composer (T-171). On an email ticket the
 * person edits the draft in the rich editor, where the recipients, the subject, the signature and the
 * formatting live, instead of in a plain text box. The card names the draft; the composer, once it is
 * open, takes it, puts the words in the editor and remembers which draft they came from, so the send
 * is recorded as an edit of that draft (N3: a person's own words, with the distance kept).
 *
 * A module-level hand-off, like `draftStore`: the card and the composer are far apart in the tree, and
 * the composer may not exist yet (the dock opens on request while the AI leads).
 */
export interface DraftHandoff {
  readonly draftId: string;
  readonly text: string;
}

const pending = new Map<string, DraftHandoff>();
const listeners = new Set<(ticketKey: string) => void>();

export const draftHandoff = {
  /** Leaves the draft for the composer of `ticketKey` and tells whoever is listening. */
  send(ticketKey: string, handoff: DraftHandoff): void {
    pending.set(ticketKey, handoff);
    for (const listener of [...listeners]) listener(ticketKey);
  },
  /** Takes the waiting draft (once). */
  take(ticketKey: string): DraftHandoff | undefined {
    const handoff = pending.get(ticketKey);
    pending.delete(ticketKey);
    return handoff;
  },
  has: (ticketKey: string): boolean => pending.has(ticketKey),
  subscribe(listener: (ticketKey: string) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  clear(): void {
    pending.clear();
  },
};
