import { describe, expect, it } from 'vitest';

import {
  assistantMessageRequestSchema,
  assistantReplySchema,
  assistantStartersQuerySchema,
  proposalCardSchema,
} from './assistant.js';
import { aiClaimsBlockSchema, claimHrefSchema, claimSchema, makeClaim } from './claims.js';

describe('claim', () => {
  it('is uncited exactly when it has no evidence', () => {
    expect(makeClaim('x').uncited).toBe(true);
    const cited = makeClaim('x', [{ kind: 'ticket', label: 'OPS-1', href: '/?ticket=OPS-1' }]);
    expect(cited.uncited).toBe(false);
    expect(claimSchema.safeParse(cited).success).toBe(true);
    // A claim cannot claim to be sourced when it is not, or the other way round.
    expect(claimSchema.safeParse({ text: 'x', evidence: [], uncited: false }).success).toBe(false);
    expect(
      claimSchema.safeParse({
        text: 'x',
        evidence: [{ kind: 'kb', label: 'Guide' }],
        uncited: true,
      }).success,
    ).toBe(false);
  });

  it.each(['/?ticket=OPS-1', '/shift/handoff', 'https://github.example/o/r/pull/3'])(
    'accepts the link %s',
    (href) => {
      expect(claimHrefSchema.safeParse(href).success).toBe(true);
    },
  );

  it.each([
    '//evil.example/x',
    'javascript:alert(1)',
    'http://plain.example/',
    'relative/page',
    '/has space',
    'data:text/html,x',
    '',
  ])('refuses the link %j', (href) => {
    expect(claimHrefSchema.safeParse(href).success).toBe(false);
  });

  it('carries mock on the evidence that came from a fixture or mock embeddings', () => {
    const claim = makeClaim('x', [{ kind: 'kb', label: 'Guide', mock: true }]);
    expect(claimSchema.parse(claim).evidence[0]?.mock).toBe(true);
  });

  it('bounds what a summary block can hold', () => {
    const block = {
      claims: [makeClaim('x')],
      generatedAt: '2026-11-02T01:00:00.000Z',
      dataAsOf: '2026-11-02T00:59:00.000Z',
      aiRunId: 'run',
      mock: true,
    };
    expect(aiClaimsBlockSchema.safeParse(block).success).toBe(true);
    expect(
      aiClaimsBlockSchema.safeParse({
        ...block,
        claims: Array.from({ length: 9 }, () => block.claims[0]),
      }).success,
    ).toBe(false);
  });
});

describe('assistant contract', () => {
  it('takes a ticket chip as an id or a number and nothing else', () => {
    const ok = (ticket: string) =>
      assistantMessageRequestSchema.safeParse({ text: 'hi', context: { page: 'ticket', ticket } })
        .success;
    expect(ok('OPS-12')).toBe(true);
    expect(ok('3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11')).toBe(true);
    expect(ok('../../etc/passwd')).toBe(false);
    expect(ok('OPS-1; DROP')).toBe(false);
  });

  it('refuses an empty message and an over-long one', () => {
    expect(assistantMessageRequestSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(assistantMessageRequestSchema.safeParse({ text: 'x'.repeat(2001) }).success).toBe(false);
    expect(assistantMessageRequestSchema.safeParse({ text: 'x'.repeat(2000) }).success).toBe(true);
  });

  it('knows seven proposal kinds and no way to send to a customer', () => {
    const base = {
      id: '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11',
      status: 'pending',
      target: null,
      changes: [],
      expiresAt: '2026-11-02T01:00:00.000Z',
    };
    for (const kind of [
      'assign',
      'status',
      'tag',
      'note',
      'create_ticket',
      'kb_draft',
      'reply_draft',
    ]) {
      expect(proposalCardSchema.safeParse({ ...base, kind }).success, kind).toBe(true);
    }
    for (const kind of ['send_reply', 'reply', 'delete', 'set_autonomy', 'merge']) {
      expect(proposalCardSchema.safeParse({ ...base, kind }).success, kind).toBe(false);
    }
  });

  it('limits a reply to five claims and three proposals', () => {
    const reply = {
      conversationId: '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11',
      messageId: '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a12',
      state: 'ok',
      reason: null,
      locale: 'th',
      claims: [],
      tools: [],
      proposals: [],
    };
    expect(assistantReplySchema.safeParse(reply).success).toBe(true);
    expect(
      assistantReplySchema.safeParse({
        ...reply,
        claims: Array.from({ length: 6 }, () => makeClaim('x')),
      }).success,
    ).toBe(false);
    expect(assistantReplySchema.safeParse({ ...reply, state: 'thinking' }).success).toBe(false);
  });

  it('defaults the starter language to English', () => {
    expect(assistantStartersQuerySchema.parse({}).locale).toBe('en');
  });
});
