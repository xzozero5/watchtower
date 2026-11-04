import { schema } from '@watchtower/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addIntent, startDomainTest, type DomainTestEnv } from '../testing/support.js';
import { templateForAi } from './templates.js';

// T-303f: a procedure step names its template; the AI still runs only the intent's own, active, `run_by_ai` one.

let env: DomainTestEnv;
beforeAll(async () => {
  env = await startDomainTest();
});
afterAll(async () => {
  await env.close();
});

const BODY = 'severity>=ERROR AND jsonPayload.org="{{org_id}}"';

describe('templateForAi with a name', () => {
  it('finds the named template of the intent, and nothing that breaks the rules of the AI', async () => {
    const intent = await addIntent(env, { allowedTools: [] });
    const other = await addIntent(env, { allowedTools: [] });
    const db = env.db.owner.db;
    await db.insert(schema.toolTemplate).values([
      { kind: 'logs', name: 'a-first', title: 'A', intentId: intent.id, body: BODY },
      { kind: 'logs', name: 'b-second', title: 'B', intentId: intent.id, body: BODY },
      {
        kind: 'logs',
        name: 'c-human-only',
        title: 'C',
        intentId: intent.id,
        body: BODY,
        runByAi: false,
      },
      {
        kind: 'logs',
        name: 'd-off',
        title: 'D',
        intentId: intent.id,
        body: BODY,
        active: false,
      },
      { kind: 'logs', name: 'e-of-other', title: 'E', intentId: other.id, body: BODY },
      { kind: 'logs', name: 'f-generic', title: 'F', intentId: null, body: BODY },
    ]);
    // No name: the first one by name, as before.
    expect((await templateForAi(db, intent.key, 'logs'))?.name).toBe('a-first');
    expect((await templateForAi(db, intent.key, 'logs', 'b-second'))?.name).toBe('b-second');
    for (const name of ['c-human-only', 'd-off', 'e-of-other', 'f-generic', 'nope']) {
      expect(await templateForAi(db, intent.key, 'logs', name), name).toBeNull();
    }
    // The right name, the wrong kind.
    expect(await templateForAi(db, intent.key, 'data', 'a-first')).toBeNull();
  });
});
