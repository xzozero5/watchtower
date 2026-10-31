import type { HumanChallenge, PortalTicketView } from '@watchtower/shared';

import { uuid } from './fixtures';

/** A challenge easy enough to solve in a test: 8 bits is about 256 hashes. */
export function makeChallenge(overrides: Partial<HumanChallenge> = {}): HumanChallenge {
  return {
    provider: 'pow-sha256',
    challenge: 'dGVzdC1jaGFsbGVuZ2U.1893456000.1893454200.8.dGVzdC1zaWduYXR1cmU',
    difficultyBits: 8,
    issuedAt: '2026-11-05T10:00:00.000Z',
    expiresAt: '2026-11-05T10:30:00.000Z',
    minFillSeconds: 0,
    ...overrides,
  };
}

export function makeView(overrides: Partial<PortalTicketView> = {}): PortalTicketView {
  return {
    key: 'OPS-12',
    subject: 'Cannot log in',
    status: 'in_progress',
    statusLabel: 'In progress',
    mergedIntoKey: null,
    maskedEmail: 'a***@example.com',
    createdAt: '2026-11-05T03:00:00.000Z',
    updatedAt: '2026-11-05T04:30:00.000Z',
    resolvedAt: null,
    expectedFirstResponseAt: null,
    canReply: true,
    timeline: [
      {
        kind: 'message',
        id: uuid(1),
        from: 'customer',
        authorName: null,
        body: 'I cannot log in since this morning.\nError 500.',
        createdAt: '2026-11-05T03:00:00.000Z',
      },
      {
        kind: 'status',
        id: uuid(2),
        status: 'in_progress',
        label: 'In progress',
        mergedIntoKey: null,
        createdAt: '2026-11-05T03:20:00.000Z',
      },
      {
        kind: 'message',
        id: uuid(3),
        from: 'support',
        authorName: 'Somchai',
        body: 'We are looking into it.',
        createdAt: '2026-11-05T04:30:00.000Z',
      },
    ],
    truncated: false,
    accessExpiresAt: '2026-11-12T03:00:00.000Z',
    ...overrides,
  };
}
