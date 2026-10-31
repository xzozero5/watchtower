import { describe, expect, it } from 'vitest';

import { userSnapshot, type UserRow } from './users.service.js';

describe('userSnapshot (C-9)', () => {
  const row = {
    id: '6b8f2e0e-8d0a-4c58-9a8e-0a7a1c2d3e4f',
    email: 'somchai@corp.example',
    name: 'Somchai Jaidee',
    role: 'agent',
    status: 'active',
    orgId: '0b8f2e0e-8d0a-4c58-9a8e-0a7a1c2d3e4f',
    isBreakGlass: false,
    passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$abc$def',
    googleSub: '1234567890',
    discordUserId: '99',
  } as unknown as UserRow;

  it('keeps the id, role, status and whether there is an address, and nothing about the person', () => {
    expect(userSnapshot(row)).toEqual({
      id: row.id,
      role: 'agent',
      status: 'active',
      hasEmail: true,
    });
    const text = JSON.stringify(userSnapshot(row));
    for (const leaked of ['somchai', 'Jaidee', 'corp.example', 'argon2', '1234567890']) {
      expect(text).not.toContain(leaked);
    }
  });
});
