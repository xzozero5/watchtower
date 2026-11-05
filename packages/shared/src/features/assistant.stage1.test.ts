import { describe, expect, it } from 'vitest';

import {
  ASSISTANT_ENTITY_KINDS,
  ASSISTANT_MAX_SELECTION,
  assistantContextSchema,
  assistantMemorySchema,
  assistantPhaseEventSchema,
  createAssistantMemorySchema,
} from './assistant.js';
import { CLAIM_EVIDENCE_KINDS, claimEvidenceSchema } from './claims.js';

describe('assistant context (ADR-029 section 1)', () => {
  it('still accepts the context of the first release', () => {
    expect(assistantContextSchema.parse({ page: 'ticket', ticket: 'OPS-12' })).toEqual({
      page: 'ticket',
      ticket: 'OPS-12',
    });
    expect(assistantContextSchema.parse({})).toEqual({});
    expect(assistantContextSchema.safeParse({ ticket: 'not a ticket' }).success).toBe(false);
    // The pages the web sends today.
    for (const page of [
      'queue',
      'ticket',
      'brief',
      'handoff',
      'dashboard',
      'kb',
      'incident',
      'other',
    ]) {
      expect(assistantContextSchema.safeParse({ page }).success, page).toBe(true);
    }
  });

  it('takes an entity, a selection of at most 20 and an element', () => {
    const ok = assistantContextSchema.safeParse({
      page: 'dashboard',
      entity: { kind: 'incident', ref: '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11' },
      selection: { kind: 'ticket', refs: ['OPS-1', 'OPS-2'] },
      element: { key: 'dashboard.ops.sla', scope: 'instance', period: 'd7' },
    });
    expect(ok.success).toBe(true);
    const many = Array.from(
      { length: ASSISTANT_MAX_SELECTION + 1 },
      (_, i) => `OPS-${String(i + 1)}`,
    );
    expect(
      assistantContextSchema.safeParse({ selection: { kind: 'ticket', refs: many } }).success,
    ).toBe(false);
    expect(
      assistantContextSchema.safeParse({ selection: { kind: 'ticket', refs: [] } }).success,
    ).toBe(false);
  });

  it('rejects a kind that is not an entity, a ref with markup and a malformed element', () => {
    expect(assistantContextSchema.safeParse({ entity: { kind: 'user', ref: 'abc' } }).success).toBe(
      false,
    );
    expect(
      assistantContextSchema.safeParse({ entity: { kind: 'ticket', ref: '<x>' } }).success,
    ).toBe(false);
    expect(
      assistantContextSchema.safeParse({ element: { key: 'Bad Key', scope: 'instance' } }).success,
    ).toBe(false);
    expect(
      assistantContextSchema.safeParse({ element: { key: 'a.b', scope: 'whatever' } }).success,
    ).toBe(false);
    expect(
      assistantContextSchema.safeParse({ element: { key: 'a.b', scope: 'org:abc', period: '7d' } })
        .success,
    ).toBe(false);
    expect(ASSISTANT_ENTITY_KINDS).toContain('kb_article');
  });
});

describe('phase events (SSE)', () => {
  it('takes each phase and refuses an unknown one', () => {
    for (const event of [
      { phase: 'queued', position: 2 },
      {
        phase: 'context',
        chips: [
          { kind: 'ticket', status: 'resolved', label: 'OPS-1', href: '/?ticket=OPS-1' },
          { kind: 'org', status: 'dropped' },
        ],
      },
      { phase: 'tool', name: 'search_tickets', status: 'running' },
      { phase: 'answering' },
      { phase: 'error', state: 'unavailable', reason: 'assistant_queue_full' },
    ]) {
      expect(assistantPhaseEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
    }
    expect(assistantPhaseEventSchema.safeParse({ phase: 'token', text: 'x' }).success).toBe(false);
    expect(assistantPhaseEventSchema.safeParse({ phase: 'queued', position: -1 }).success).toBe(
      false,
    );
  });
});

describe('memory', () => {
  it('is made from a claim of an answer, never from typed text', () => {
    const messageId = '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11';
    expect(createAssistantMemorySchema.safeParse({ messageId, claim: 0 }).success).toBe(true);
    expect(createAssistantMemorySchema.safeParse({ messageId, claim: 5 }).success).toBe(false);
    // A body in the request is not part of the contract and is dropped.
    expect(createAssistantMemorySchema.parse({ messageId, claim: 1, body: 'typed' })).toEqual({
      messageId,
      claim: 1,
    });
    const now = new Date().toISOString();
    expect(
      assistantMemorySchema.safeParse({
        id: messageId,
        body: 'x'.repeat(301),
        refs: [],
        sourceMessageId: null,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: now,
      }).success,
    ).toBe(false);
  });
});

describe('claim evidence (ADR-029 section 5)', () => {
  it('has the new kinds and an optional ref', () => {
    for (const kind of ['conversation', 'statuspage', 'shift', 'metric', 'intent', 'config']) {
      expect(CLAIM_EVIDENCE_KINDS).toContain(kind);
    }
    expect(claimEvidenceSchema.safeParse({ kind: 'ticket', label: 'OPS-1' }).success).toBe(true);
    expect(
      claimEvidenceSchema.safeParse({
        kind: 'ticket',
        label: 'OPS-1',
        ref: { kind: 'ticket', id: 't1' },
      }).success,
    ).toBe(true);
    expect(
      claimEvidenceSchema.safeParse({ kind: 'ticket', label: 'x', ref: { kind: 'nope', id: 't1' } })
        .success,
    ).toBe(false);
  });
});
