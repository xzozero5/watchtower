import { describe, expect, it } from 'vitest';
import { makeClaim } from '@watchtower/shared';

import { assistantCitationMetrics } from './assistant-citations.js';
import { assistantCaseSchema } from './assistant-case.js';
import { createRig } from './rig.js';
import { runCase } from './run.js';

describe('assistant citation metrics', () => {
  it('deduplicates refs, matches kind and id, and counts evidence-free claims', () => {
    const ref = { kind: 'ticket' as const, id: 't1' };
    const claims = [
      makeClaim('One.', [{ kind: 'ticket', label: 'One', ref }]),
      makeClaim('Again.', [{ kind: 'ticket', label: 'Changed label', ref }]),
      makeClaim('Unsupported.'),
    ];
    expect(assistantCitationMetrics(claims, [ref, ref, { kind: 'incident', id: 't1' }])).toEqual({
      requiredRefs: 2,
      matchedRefs: 1,
      citationRecall: 0.5,
      uncitedClaims: 1,
    });
    expect(assistantCitationMetrics([], []).citationRecall).toBeNull();
  });

  it('runs a proposal through the actual assistant and reports citation metrics', async () => {
    const item = assistantCaseSchema.parse({
      id: 'assistant.test',
      agent: 'personal_assistant',
      input: {
        role: 'agent',
        locale: 'en',
        question: 'Tell me more',
        entities: [{ kind: 'incident', id: 'i1', label: 'Incident' }],
        fixtures: [
          {
            tool: 'incident_get',
            facts: [
              {
                kind: 'incident',
                label: 'Incident',
                ref: { kind: 'incident', id: 'i1' },
                trust: 'system',
                text: '2 open incidents.',
              },
            ],
          },
        ],
      },
      mockAnswer: { claims: [{ text: '2 open incidents.', evidenceIds: ['e1'] }] },
      expect: { mustCiteRefs: [{ kind: 'incident', id: 'i1' }], path: 'llm1', maxUncited: 0 },
    });
    const result = await runCase(
      createRig({ provider: 'mock', maxCalls: 4, env: {} }),
      item,
      'proposal',
      {},
    );
    expect(result.pass).toBe(true);
    expect(result.calls).toBe(1);
    expect(result.citationMetrics).toEqual({
      requiredRefs: 1,
      matchedRefs: 1,
      citationRecall: 1,
      uncitedClaims: 0,
    });
  });
});
