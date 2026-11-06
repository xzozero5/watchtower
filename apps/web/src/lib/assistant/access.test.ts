import { describe, expect, it } from 'vitest';
import { makeSession, uuid } from '@/test/fixtures';
import { isAssistantWorkspace } from './access';

describe('assistant workspace allowlist', () => {
  it.each(['agent', 'lead', 'head', 'dev'] as const)('accepts workspace role %s', (role) => {
    expect(isAssistantWorkspace(makeSession(role))).toBe(true);
  });
  it.each(['client', 'system'] as const)('rejects %s even with assistant.use', (role) => {
    expect(isAssistantWorkspace(makeSession(role, { permissions: ['assistant.use'] }))).toBe(false);
  });
  it('rejects an organization-bound session and a missing session', () => {
    const staff = makeSession('head');
    expect(isAssistantWorkspace({ ...staff, user: { ...staff.user, orgId: uuid(500) } })).toBe(
      false,
    );
    expect(isAssistantWorkspace(null)).toBe(false);
  });
});
