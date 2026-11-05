import { describe, expect, it } from 'vitest';

import { answerText } from '@/components/assistant/assistant-panel';

import { contextForRequest, contextKey, NONE_REMOVED, type PageContext } from './page-context';

const base: PageContext = { page: 'ticket', entity: null, selection: null, label: null, pin: 0 };

describe('page context', () => {
  it('sends only the chips that were left on', () => {
    const context: PageContext = { ...base, entity: { kind: 'ticket', ref: 'OPS-12' } };
    expect(contextForRequest(context, NONE_REMOVED)).toEqual({
      page: 'ticket',
      entity: { kind: 'ticket', ref: 'OPS-12' },
      ticket: 'OPS-12',
    });
    expect(contextForRequest(context, { ...NONE_REMOVED, page: true })).toEqual({
      entity: { kind: 'ticket', ref: 'OPS-12' },
      ticket: 'OPS-12',
    });
    expect(
      contextForRequest(context, { page: true, entity: true, selection: true }),
    ).toBeUndefined();
  });

  it('sends the entity of another kind without the old ticket field, and never the display label', () => {
    const context: PageContext = {
      ...base,
      page: 'incident',
      entity: { kind: 'incident', ref: 'abc-1' },
      label: 'INC-7',
    };
    const sent = contextForRequest(context, NONE_REMOVED);
    expect(sent).toEqual({ page: 'incident', entity: { kind: 'incident', ref: 'abc-1' } });
    expect(JSON.stringify(sent)).not.toContain('INC-7');
  });

  it('sends a selection only while its chip is on', () => {
    const context: PageContext = {
      ...base,
      selection: { kind: 'ticket', refs: ['OPS-1', 'OPS-2'] },
    };
    expect(contextForRequest(context, NONE_REMOVED)?.selection).toEqual({
      kind: 'ticket',
      refs: ['OPS-1', 'OPS-2'],
    });
    expect(contextForRequest(context, { ...NONE_REMOVED, selection: true })?.selection).toBe(
      undefined,
    );
  });

  it('makes a new key when the place, the thing or the press changes', () => {
    const a: PageContext = { ...base, entity: { kind: 'org', ref: 'o1' } };
    expect(contextKey(a)).toBe(contextKey({ ...a }));
    expect(contextKey(a)).not.toBe(contextKey({ ...a, entity: { kind: 'org', ref: 'o2' } }));
    expect(contextKey(a)).not.toBe(contextKey({ ...a, pin: 2 }));
    expect(contextKey(a)).not.toBe(contextKey({ ...a, page: 'admin' }));
  });
});

describe('answerText', () => {
  it('copies each sentence with its sources', () => {
    const text = answerText({
      conversationId: '11111111-1111-4111-8111-111111111111',
      messageId: '33333333-3333-4333-8333-333333333333',
      state: 'ok',
      reason: null,
      locale: 'en',
      claims: [
        { text: 'A.', evidence: [{ kind: 'ticket', label: 'OPS-1' }], uncited: false },
        { text: 'B.', evidence: [], uncited: true },
      ],
      tools: [],
      proposals: [],
    });
    expect(text).toBe('A. [OPS-1]\nB.');
  });
});
