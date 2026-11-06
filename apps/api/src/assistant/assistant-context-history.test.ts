import { describe, expect, it } from 'vitest';

import { conversationRefs, trackAssistantPiiRead } from './assistant-context-history.js';

describe('conversation dictionary refs (C-8)', () => {
  it('audits model-read handoff and mail even without a chip, once per source', () => {
    const tickets = new Map([['ticket-id', 'OPS-1']]);
    const others = new Map<string, { readonly kind: string; readonly id: string }>();
    for (const kind of ['handoff', 'handoff', 'conversation'])
      trackAssistantPiiRead({ kind, id: 'source-id' }, tickets, others);
    trackAssistantPiiRead({ kind: 'ticket', id: 'ticket-id' }, tickets, others);
    expect([...others.values()]).toEqual([
      { kind: 'handoff', id: 'source-id' },
      { kind: 'conversation', id: 'source-id' },
    ]);
    expect(tickets.get('ticket-id')).toBe('OPS-1');
  });
  it('keeps server-owned read refs even when no claim cites the source', () => {
    expect(
      conversationRefs([
        {
          context: {
            readRefs: [
              { kind: 'conversation', ref: 'uncited-mail-id' },
              { kind: 'service', ref: 'service-id' },
              { kind: 'handoff', ref: 'handoff-id' },
              { kind: 'org', ref: 'org-id' },
              { kind: 'intent', ref: 'intent-id' },
            ],
          },
          evidence: [{ kind: 'conversation', id: 'cited-mail-id' }],
        },
      ]),
    ).toEqual([
      { kind: 'conversation', ref: 'uncited-mail-id' },
      { kind: 'service', ref: 'service-id' },
      { kind: 'handoff', ref: 'handoff-id' },
      { kind: 'org', ref: 'org-id' },
      { kind: 'intent', ref: 'intent-id' },
      { kind: 'conversation', ref: 'cited-mail-id' },
    ]);
  });

  it('retains entity, selection, old ticket and tool-read mail identities beyond twenty turns', () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      context: { ticket: `OPS-${String(index + 1)}` },
      evidence: [],
    }));
    const refs = conversationRefs([
      ...rows,
      {
        context: {
          entity: { kind: 'incident', ref: 'incident-id' },
          selection: { kind: 'org', refs: ['org-1', 'org-2'] },
        },
        evidence: [
          { kind: 'conversation', id: 'mail-id' },
          { kind: 'kb', id: 'kb-id' },
        ],
      },
    ]);
    expect(refs).toHaveLength(30);
    expect(refs).toContainEqual({ kind: 'ticket', ref: 'OPS-1' });
    expect(refs).toContainEqual({ kind: 'incident', ref: 'incident-id' });
    expect(refs).toContainEqual({ kind: 'org', ref: 'org-2' });
    expect(refs).toContainEqual({ kind: 'conversation', ref: 'mail-id' });
    expect(refs).toContainEqual({ kind: 'kb_article', ref: 'kb-id' });
  });

  it('deduplicates refs and ignores malformed stored context', () => {
    expect(
      conversationRefs([
        {
          context: { entity: { kind: 'org', ref: 'org-1' } },
          evidence: [{ kind: 'org', id: 'org-1' }],
        },
        { context: { entity: { kind: 'not-a-kind', ref: 'secret' } }, evidence: [] },
      ]),
    ).toEqual([{ kind: 'org', ref: 'org-1' }]);
  });
});
