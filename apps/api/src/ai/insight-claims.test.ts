import type { AiEvidence, AiReport } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { claimsOfReport, ticketKeyOfHref } from './insight-claims.js';
import { pickLocale } from './locale.js';

const card = (id: string, extra: Partial<AiEvidence> = {}): AiEvidence => ({
  id,
  kind: 'ticket',
  title: `Card ${id}`,
  snippet: 's',
  confidence: 1,
  ...extra,
});

const report = (findings: AiReport['findings']): AiReport => ({
  findings,
  likelyCause: null,
  confidence: 0.5,
  openQuestions: [],
  tools: [],
  promptVersion: 'v1',
});

describe('claimsOfReport', () => {
  it('makes a claim of each finding with a chip for each card it cites', () => {
    const claims = claimsOfReport(
      report([{ text: 'A similar ticket exists.', evidenceIds: ['ev-1'] }]),
      [card('ev-1', { href: '/?ticket=OPS-7' })],
      new Set(['OPS-7']),
    );
    expect(claims).toEqual([
      {
        text: 'A similar ticket exists.',
        evidence: [{ kind: 'ticket', label: 'Card ev-1', href: '/?ticket=OPS-7' }],
        uncited: false,
      },
    ]);
  });

  it('rewrites the older /tickets/KEY link to the page that exists', () => {
    const [claim] = claimsOfReport(
      report([{ text: 'x', evidenceIds: ['ev-1'] }]),
      [card('ev-1', { href: '/tickets/OPS-7' })],
      new Set(['OPS-7']),
    );
    expect(claim?.evidence[0]?.href).toBe('/?ticket=OPS-7');
  });

  it('gives no link for a ticket the viewer cannot open, and none for a knowledge base page that does not exist', () => {
    const claims = claimsOfReport(
      report([
        { text: 'Other org.', evidenceIds: ['ev-1'] },
        { text: 'A guide says so.', evidenceIds: ['ev-2'] },
      ]),
      [card('ev-1', { href: '/?ticket=OPS-9' }), card('ev-2', { kind: 'kb', href: '/kb/unlock' })],
      new Set(),
    );
    expect(claims[0]?.evidence[0]).toEqual({ kind: 'ticket', label: 'Card ev-1' });
    expect(claims[1]?.evidence[0]).toEqual({ kind: 'kb', label: 'Card ev-2' });
    expect(claims.every((claim) => !claim.uncited)).toBe(true);
  });

  it('marks a finding that cites nothing real as uncited and carries mock through', () => {
    const claims = claimsOfReport(
      report([
        { text: 'No card.', evidenceIds: [] },
        { text: 'Unknown id.', evidenceIds: ['ev-404'] },
        { text: 'Fixture.', evidenceIds: ['ev-3'] },
      ]),
      [card('ev-3', { kind: 'log', mock: true })],
      new Set(),
    );
    expect(claims.map((claim) => claim.uncited)).toEqual([true, true, false]);
    expect(claims[2]?.evidence[0]).toEqual({ kind: 'log', label: 'Card ev-3', mock: true });
  });

  it('never passes on a link that is not an app path or an https URL', () => {
    const [claim] = claimsOfReport(
      report([{ text: 'x', evidenceIds: ['ev-1'] }]),
      [card('ev-1', { kind: 'repo', href: 'javascript:alert(1)' })],
      new Set(),
    );
    expect(claim?.evidence[0]?.href).toBeUndefined();
    const [web] = claimsOfReport(
      report([{ text: 'x', evidenceIds: ['ev-1'] }]),
      [card('ev-1', { kind: 'repo', href: 'https://git.example/o/r/pull/1' })],
      new Set(),
    );
    expect(web?.evidence[0]?.href).toBe('https://git.example/o/r/pull/1');
  });
});

describe('ticketKeyOfHref', () => {
  it.each([
    ['/?ticket=OPS-12', 'OPS-12'],
    ['/tickets/OPS-12', 'OPS-12'],
    ['/kb/unlock', null],
    ['/?ticket=../x', null],
    [undefined, null],
  ])('%s -> %s', (href, key) => {
    expect(ticketKeyOfHref(href)).toBe(key);
  });
});

describe('pickLocale', () => {
  it('prefers the locale the web names, then Accept-Language, then English', () => {
    expect(pickLocale('th', 'en-US')).toBe('th');
    expect(pickLocale(undefined, 'th-TH,th;q=0.9,en;q=0.8')).toBe('th');
    expect(pickLocale(undefined, 'fr-FR, en;q=0.5')).toBe('en');
    expect(pickLocale('xx', undefined)).toBe('en');
    expect(pickLocale(undefined, undefined)).toBe('en');
  });
});
