import { describe, expect, it } from 'vitest';

import { createAuditedLlm } from '../audited.js';
import type { LlmRequest } from '../contract.js';
import { mockSettings } from '../models.js';
import { loadPromptCatalog } from '../prompt-files.js';
import { createRedactor } from '../redaction/redactor.js';
import { ALLOW_ALL_GUARD } from '../test-guard.js';
import type { AgentDeps } from './common.js';
import { draftReply } from './draft.js';

// T-302a: golden answers reach the drafter as examples of style, through its redaction session.
const TICKET = '11111111-1111-4111-8111-111111111111';

function rig() {
  const requests: LlmRequest[] = [];
  const answer = { sentences: [{ text: 'Hello.', kind: 'courtesy', evidenceIds: [] }] };
  const deps: AgentDeps = {
    llm: createAuditedLlm({
      guard: ALLOW_ALL_GUARD,
      settings: { load: () => Promise.resolve(mockSettings()) },
      providers: {
        mock: {
          kind: 'mock',
          generate: (request) => {
            requests.push(request);
            return Promise.resolve({
              text: JSON.stringify(answer),
              finishReason: 'stop' as const,
              usage: { inputTokens: 1, outputTokens: 1 },
              model: request.model,
            });
          },
        },
      },
      sink: { record: () => Promise.resolve({ id: '00000000-0000-4000-8000-000000000001' }) },
    }),
    redactor: createRedactor(),
    prompts: loadPromptCatalog(),
    guard: { check: () => Promise.resolve({ allowed: true as const }) },
  };
  return { deps, requests };
}

const input = {
  ticketId: TICKET,
  subject: 'Webhook not received',
  intentKey: null,
  customerLanguage: 'en' as const,
  disclosure: 'restricted' as const,
  evidence: [],
  turns: [{ from: 'customer' as const, text: 'Hi' }],
};

describe('golden examples in the draft prompt', () => {
  it('shows the model at most three examples as style only, with no placeholder it could hand back', async () => {
    const { deps, requests } = rig();
    await draftReply(deps, {
      ...input,
      examples: [
        'Dear [NAME_1], we reset it. Write to [EMAIL_2] again.',
        'Second example',
        'Third example',
        'Fourth example',
      ],
    });
    const sent = JSON.stringify(requests);
    expect(sent).toContain('golden_examples');
    expect(sent).toContain('Second example');
    expect(sent).toContain('Third example');
    expect(sent).not.toContain('Fourth example');
    expect(sent).toContain('tone and structure');
    expect(sent).not.toContain('[NAME_1], we reset');
    expect(sent).not.toContain('[EMAIL_2]');
  });

  it('adds no block without examples', async () => {
    const { deps, requests } = rig();
    await draftReply(deps, input);
    expect(JSON.stringify(requests)).not.toContain('golden_examples');
  });

  it('redacts a detail that slipped into an example', async () => {
    const { deps, requests } = rig();
    await draftReply(deps, {
      ...input,
      examples: ['Call back on 0812345678 or mail old.customer@example.test'],
    });
    const sent = JSON.stringify(requests);
    expect(sent).toContain('golden_examples');
    expect(sent).not.toContain('old.customer@example.test');
  });
});
