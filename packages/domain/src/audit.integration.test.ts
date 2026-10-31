import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { recordAuditInTx } from './audit.js';
import { auditRows, startDomainTest, type DomainTestEnv } from './testing/support.js';
import { Effects } from './types.js';

let env: DomainTestEnv;

beforeAll(async () => {
  env = await startDomainTest();
});
afterAll(async () => {
  await env.close();
});

describe('recordAuditInTx', () => {
  it('redacts secrets, stamps the source, marks the effects, and commits with the transaction', async () => {
    const fx = new Effects();
    await env.tx((tx) =>
      recordAuditInTx(tx, env.ctx({ type: 'system', id: null }), fx, {
        action: 'test.audit',
        targetType: 'thing',
        targetId: 'thing-1',
        after: { name: 'visible', apiToken: 'must-not-appear' },
        metadata: { password: 'must-not-appear' },
      }),
    );
    expect(fx.audited).toBe(true);
    const [row] = await auditRows(env, 'test.audit');
    expect(row).toMatchObject({
      actorType: 'system',
      ip: '203.0.113.7',
      requestId: 'req-test',
      outcome: 'success',
    });
    expect(JSON.stringify(row)).not.toContain('must-not-appear');
    expect(JSON.stringify(row)).toContain('visible');
  });

  it('leaves no row when the transaction rolls back', async () => {
    await expect(
      env.tx(async (tx) => {
        await recordAuditInTx(tx, env.ctx(), new Effects(), { action: 'test.rolled_back' });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await auditRows(env, 'test.rolled_back')).toEqual([]);
  });

  it('cannot be changed afterwards by the application role (append-only)', async () => {
    await env.tx((tx) => recordAuditInTx(tx, env.ctx(), new Effects(), { action: 'test.append' }));
    await expect(
      env.database.pool.query("UPDATE audit_log SET action = 'x' WHERE action = 'test.append'"),
    ).rejects.toThrow();
  });
});
