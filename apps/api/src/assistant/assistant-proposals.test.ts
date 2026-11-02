import { KB_SLUG_PATTERN } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { slugFor, toCard } from './assistant-proposals.js';

describe('slugFor', () => {
  it('makes a valid knowledge base slug from a title, with a random tail so two drafts never collide', () => {
    const a = slugFor('How to reset a password (v2)!');
    expect(a).toMatch(/^how-to-reset-a-password-v2-[0-9a-f]{6}$/);
    expect(KB_SLUG_PATTERN.test(a)).toBe(true);
    expect(slugFor('How to reset a password (v2)!')).not.toBe(a);
  });

  it('still makes one for a title with no letters we can use (Thai)', () => {
    const slug = slugFor('วิธีรีเซ็ตรหัสผ่าน');
    expect(slug).toMatch(/^draft-[0-9a-f]{6}$/);
    expect(KB_SLUG_PATTERN.test(slug)).toBe(true);
  });

  it('stays inside the length the schema allows', () => {
    expect(KB_SLUG_PATTERN.test(slugFor('x'.repeat(500)))).toBe(true);
  });
});

describe('toCard', () => {
  const row = {
    id: '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11',
    kind: 'note',
    status: 'pending',
    expiresAt: new Date('2026-11-02T01:10:00.000Z'),
    card: {
      locale: 'en',
      target: { key: 'OPS-1', label: 'Cannot sign in', href: '/?ticket=OPS-1' },
      changes: [],
      text: 'called the customer',
    },
  } as never;

  it('is the contract: the stored card plus the id, status and expiry of the row, and nothing of the locale', () => {
    const card = toCard(row);
    expect(card).toEqual({
      id: '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11',
      kind: 'note',
      status: 'pending',
      target: { key: 'OPS-1', label: 'Cannot sign in', href: '/?ticket=OPS-1' },
      changes: [],
      text: 'called the customer',
      expiresAt: '2026-11-02T01:10:00.000Z',
    });
    expect(JSON.stringify(card)).not.toContain('locale');
  });

  it('shows the current values when it is given them (a stale card)', () => {
    const card = toCard(row, [{ field: 'status', from: 'open', to: 'resolved' }]);
    expect(card.changes).toEqual([{ field: 'status', from: 'open', to: 'resolved' }]);
  });
});
