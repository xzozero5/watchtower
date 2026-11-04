import { describe, expect, it } from 'vitest';

import { answerText } from '@/components/assistant/assistant-panel';

import { contextForRequest, pageOfPath, ticketOfLocation } from './page-context';

describe('page context', () => {
  it('names the page kind the api knows, and nothing it does not', () => {
    expect(pageOfPath('/', null)).toBe('queue');
    expect(pageOfPath('/', 'OPS-1')).toBe('ticket');
    expect(pageOfPath('/shift/brief', null)).toBe('brief');
    expect(pageOfPath('/shift/handoff', null)).toBe('handoff');
    expect(pageOfPath('/shift', null)).toBe('other');
    expect(pageOfPath('/home', null)).toBe('dashboard');
    expect(pageOfPath('/incidents/abc', null)).toBe('incident');
    expect(pageOfPath('/admin/users', null)).toBe('other');
  });

  it('reads the open ticket from the address only on the queue, and only a valid reference', () => {
    expect(ticketOfLocation('/', '?ticket=OPS-12')).toBe('OPS-12');
    expect(ticketOfLocation('/', '?ticket=not a ticket!')).toBeNull();
    expect(ticketOfLocation('/home', '?ticket=OPS-12')).toBeNull();
  });

  it('sends only the chips that were left on', () => {
    const context = { page: 'ticket' as const, ticket: 'OPS-12' };
    expect(contextForRequest(context, { page: false, ticket: false })).toEqual({
      page: 'ticket',
      ticket: 'OPS-12',
    });
    expect(contextForRequest(context, { page: true, ticket: false })).toEqual({ ticket: 'OPS-12' });
    expect(contextForRequest(context, { page: true, ticket: true })).toBeUndefined();
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
