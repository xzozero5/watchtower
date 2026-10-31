import type { Permission } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import type { Principal } from '../auth/principal.js';
import { audienceFor } from './realtime.gateway.js';

const ORG = '0b3f7a9c-1e0d-4c53-9a5e-6f2f3f4c9d10';

function principal(scope: Principal['orgScope'], permissions: Permission[]): Principal {
  return {
    userId: 'u',
    sessionId: 's',
    email: 'a@example.com',
    name: 'A',
    role: scope.kind === 'org' ? 'client' : 'agent',
    orgId: scope.kind === 'org' ? scope.orgId : null,
    authMethod: 'dev',
    accessExpiresAt: new Date(),
    permissions: new Set(permissions),
    orgScope: scope,
  };
}

describe('audienceFor', () => {
  it('lets staff with ticket.read hear everything', () => {
    expect(audienceFor(principal({ kind: 'all' }, ['ticket.read']))).toEqual({ kind: 'staff' });
  });

  it('limits a client to their organization', () => {
    expect(audienceFor(principal({ kind: 'org', orgId: ORG }, ['ticket.read.org']))).toEqual({
      kind: 'client',
      orgId: ORG,
    });
  });

  it('refuses staff who only have the client permission, and clients who only have the staff one', () => {
    expect(audienceFor(principal({ kind: 'all' }, ['ticket.read.org']))).toBeNull();
    expect(audienceFor(principal({ kind: 'org', orgId: ORG }, ['ticket.read']))).toBeNull();
  });

  it('refuses a caller who may read no tickets', () => {
    expect(audienceFor(principal({ kind: 'all' }, []))).toBeNull();
    expect(audienceFor(principal({ kind: 'org', orgId: ORG }, []))).toBeNull();
  });
});
