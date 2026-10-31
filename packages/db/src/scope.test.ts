import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { orgScopeCondition } from './scope.js';
import { users } from './schema/index.js';

const dialect = new PgDialect();
const ORG = '6d8f0a1e-0000-4000-8000-00000000000a';

describe('orgScopeCondition', () => {
  it('adds no condition for staff, who see every organization', () => {
    expect(orgScopeCondition(users.orgId, { kind: 'all' })).toBeUndefined();
  });

  it('limits a client to their organization with a bound parameter, never string-built', () => {
    const condition = orgScopeCondition(users.orgId, { kind: 'org', orgId: ORG });
    expect(condition).toBeDefined();
    if (!condition) return;
    const query = dialect.sqlToQuery(condition);
    expect(query.sql).toBe('"users"."org_id" = $1');
    expect(query.params).toEqual([ORG]);
  });

  it('keeps an injection attempt in an organization id inside the parameter', () => {
    const hostile = "x' OR '1'='1";
    const condition = orgScopeCondition(users.orgId, { kind: 'org', orgId: hostile });
    const query = dialect.sqlToQuery(condition ?? (undefined as never));
    expect(query.sql).not.toContain('OR');
    expect(query.params).toEqual([hostile]);
  });
});
