import { describe, expect, it } from 'vitest';

import { notFound } from './http-errors.js';
import { assertOrgAccess, canAccessOrg, orgScopeFor, type Principal } from './principal.js';

const ORG_A = '6d8f0a1e-0000-4000-8000-00000000000a';
const ORG_B = '6d8f0a1e-0000-4000-8000-00000000000b';

function principal(role: Principal['role'], orgId: string | null): Principal {
  return {
    userId: 'u',
    sessionId: 's',
    email: 'u@example.com',
    name: 'U',
    role,
    orgId,
    authMethod: 'dev',
    accessExpiresAt: new Date(),
    permissions: new Set(),
    orgScope: orgScopeFor(role, orgId),
  };
}

describe('organization scope', () => {
  it('gives staff every organization and a client exactly their own', () => {
    expect(orgScopeFor('agent', null)).toEqual({ kind: 'all' });
    expect(orgScopeFor('lead', null)).toEqual({ kind: 'all' });
    expect(orgScopeFor('head', null)).toEqual({ kind: 'all' });
    expect(orgScopeFor('system', null)).toEqual({ kind: 'all' });
    expect(orgScopeFor('client', ORG_A)).toEqual({ kind: 'org', orgId: ORG_A });
  });

  it('fails closed for a client without an organization instead of widening to everything', () => {
    expect(() => orgScopeFor('client', null)).toThrow(/without an organization/);
  });

  it('lets a client reach their own organization only', () => {
    const client = principal('client', ORG_A);
    expect(canAccessOrg(client, ORG_A)).toBe(true);
    expect(canAccessOrg(client, ORG_B)).toBe(false);
    expect(canAccessOrg(principal('agent', null), ORG_B)).toBe(true);
  });

  it('answers 404 for another organization, indistinguishable from a record that does not exist', () => {
    const client = principal('client', ORG_A);
    expect(() => {
      assertOrgAccess(client, ORG_B);
    }).toThrow(notFound());
    expect(() => {
      assertOrgAccess(client, ORG_A);
    }).not.toThrow();
  });
});
