import type { Principal } from '../auth/principal.js';
import { assistantMessageRequestSchema } from '@watchtower/shared';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '@watchtower/db';
import { AuditService } from '../audit/audit.service.js';
import { resolveContext } from './context-resolver.js';

import {
  AssistantHistoryAuthorization,
  authorizationFingerprint,
  makeAssistantAuthorization,
  storedAuthorization,
  conversationRefs,
  trackAssistantPiiRead,
} from './assistant-context-history.js';

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

const principal: Principal = {
  userId: '00000000-0000-4000-8000-000000000001',
  sessionId: 'session-a',
  email: 'synthetic@example.com',
  name: 'Synthetic',
  role: 'agent',
  orgId: null,
  authMethod: 'dev',
  accessExpiresAt: new Date(),
  orgScope: { kind: 'all' },
  permissions: new Set(['ticket.read', 'kb.read']),
};

describe('private authorization snapshot (ADR-034)', () => {
  it('is stable across session rotation and permission ordering, but changes on user/role/permission/org scope', () => {
    const key = authorizationFingerprint(principal);
    expect(
      authorizationFingerprint({
        ...principal,
        sessionId: 'session-b',
        permissions: new Set(['kb.read', 'ticket.read']),
      }),
    ).toBe(key);
    for (const changed of [
      { ...principal, userId: 'other' },
      { ...principal, role: 'dev' as const },
      { ...principal, permissions: new Set<never>() },
      { ...principal, orgScope: { kind: 'org' as const, orgId: 'other' } },
    ])
      expect(authorizationFingerprint(changed)).not.toBe(key);
  });
  it('keeps only bounded stable refs and tool names, never request metadata or raw tool arguments', () => {
    const snapshot = makeAssistantAuthorization(
      principal,
      [
        { kind: 'org', ref: 'org-a' },
        { kind: 'org', ref: 'org-a' },
      ],
      ['org_get', 'org_get'],
    );
    expect(snapshot?.refs).toHaveLength(1);
    expect(snapshot?.tools).toEqual(['org_get']);
    expect(
      makeAssistantAuthorization(
        principal,
        Array.from({ length: 401 }, (_, i) => ({ kind: 'org', ref: String(i) })),
        [],
      ),
    ).toBeNull();
    const request = assistantMessageRequestSchema.parse({
      text: 'hello',
      context: { authorization: snapshot, readRefs: snapshot?.refs },
    });
    expect(storedAuthorization(request.context)).toBeUndefined();
    expect(request.context).not.toHaveProperty('readRefs');
  });
});

vi.mock('./read-only.js', () => ({
  inReadOnlyScope: (work: () => Promise<unknown>) => work(),
}));
const database = createDatabase({ url: 'postgres://localhost:1/unreachable' });
afterAll(() => database.close());

describe('reauthorization fails closed before history or memory can reuse content', () => {
  it('requires every source and current tool permission, and withholds on reader or PII audit failure', async () => {
    const audit = new AuditService(database);
    const readAudit = vi.spyOn(audit, 'recordPiiRead').mockResolvedValue(undefined);
    const reader = vi.fn((id: string) =>
      Promise.resolve({ kind: 'ticket' as const, id, label: 'OPS-1' }),
    );
    const resolver = {
      resolve: (context: Parameters<typeof resolveContext>[0], caller: Principal) =>
        resolveContext(context, caller, { ticket: reader }),
    };
    const gate = new AssistantHistoryAuthorization(database, resolver, audit);
    const snapshot = makeAssistantAuthorization(
      principal,
      [{ kind: 'ticket', ref: 'OPS-1' }],
      ['summarize_ticket'],
    );
    expect(await gate.authorize(principal, snapshot)).toEqual(snapshot);
    expect(readAudit).toHaveBeenCalledOnce();
    expect(
      await gate.authorize({ ...principal, permissions: new Set(['kb.read']) }, snapshot),
    ).toBeNull();
    expect(await gate.authorize(principal, { ...snapshot, tools: ['ceo_metrics'] })).toBeNull();
    expect(
      await gate.authorize(principal, { ...snapshot, rawArguments: { query: 'never store this' } }),
    ).toBeNull();
    expect(await gate.authorize(principal, undefined)).toBeNull();
    reader.mockRejectedValueOnce(new Error('reader unavailable'));
    expect(await gate.authorize(principal, snapshot)).toBeNull();
    readAudit.mockRejectedValueOnce(new Error('audit unavailable'));
    expect(await gate.authorize(principal, snapshot)).toBeNull();
    const noReader = new AssistantHistoryAuthorization(
      database,
      { resolve: (context, caller) => resolveContext(context, caller, {}) },
      audit,
    );
    expect(await noReader.authorize(principal, snapshot)).toBeNull();
  });
});
