import { describe, expect, it } from 'vitest';

import { createRedactor } from '../redaction/redactor.js';
import { protectEvidence, rawEvidenceFrom } from './evidence.js';

const hit = {
  articleId: 'a1',
  slug: 'reset',
  title: 'Reset a password',
  section: 'Steps',
  snippet: 'Open settings.',
  score: 1,
  kind: 'article',
  lang: 'en',
  customerVisible: false,
  isRunbook: false,
  href: '/kb/reset',
};

describe('evidence scored by mock embeddings (N5)', () => {
  const session = () => createRedactor().session({ scope: 'ticket-1' });

  it('carries mock on a knowledge base card whose rank came from mock embeddings', () => {
    const raw = rawEvidenceFrom('kb_search', { items: [{ ...hit, mock: true }] });
    const [card] = protectEvidence(session(), raw, 1);
    expect(card?.card.mock).toBe(true);
    // The model is told too, so it does not present the rank as a measure of fit.
    expect(card?.forModel).toContain('mock data');
  });

  it('does not call a keyword hit mock', () => {
    const [card] = protectEvidence(session(), rawEvidenceFrom('kb_search', { items: [hit] }), 1);
    expect(card?.card.mock).toBe(false);
    expect(card?.forModel).not.toContain('mock data');
  });

  it('still marks logs read from a fixture', () => {
    const raw = rawEvidenceFrom('gcp_logs', {
      mock: true,
      items: [{ timestamp: 't', severity: 'ERROR', service: 'svc', message: 'boom' }],
    });
    expect(protectEvidence(session(), raw, 1)[0]?.card.mock).toBe(true);
  });
});
