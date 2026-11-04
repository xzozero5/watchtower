import { describe, expect, it } from 'vitest';

import {
  CONDITION_FIELDS,
  EMPTY_PROCEDURE_STEPS,
  PROCEDURE_GENERIC_TOOLS,
  PROCEDURE_LIMITS,
  PROCEDURE_TOOL_NAMES,
  conditionSchema,
  evaluateCondition,
  procedureStepsSchema,
  procedureTextBytes,
  type Condition,
  type ProcedureStepsInput,
} from './procedure.js';
import { DEFAULT_ROLE_PERMISSIONS } from './rbac.js';

const valid = (over: Partial<ProcedureStepsInput> = {}): ProcedureStepsInput => ({
  schemaVersion: 1,
  autosend: 'never',
  steps: [
    {
      kind: 'tool',
      id: 'logs',
      tool: 'gcp_logs',
      template: 'errors_last_hour',
      params: { limit: 10, windowMinutes: 60 },
    },
    {
      kind: 'tool',
      id: 'kb',
      tool: 'kb_search',
      when: { all: [{ field: 'ticket.priority', op: 'in', value: ['P1', 'P2'] }] },
      stages: [1, 2],
    },
    {
      kind: 'check',
      id: 'was_error',
      question: 'Did the logs show an error at the time?',
      evidenceFrom: ['logs'],
    },
    { kind: 'reply_guideline', id: 'tone', text: 'Be brief and say what we checked.', lang: 'en' },
    {
      kind: 'disclosure',
      id: 'no_internal',
      rule: 'never_mention',
      topic: 'internal system names',
    },
    {
      kind: 'escalate',
      id: 'p1',
      when: { all: [{ field: 'ticket.priority', op: 'eq', value: 'P1' }] },
      to: { role: 'lead' },
      note: 'Wake the lead.',
    },
    {
      kind: 'require_human',
      id: 'reopened',
      when: { any: [{ field: 'ticket.reopenCount', op: 'gte', value: 2 }] },
      reason: 'Reopened twice.',
    },
  ],
  ...over,
});

describe('procedureStepsSchema', () => {
  it('accepts a full procedure and defaults autosend to never', () => {
    const parsed = procedureStepsSchema.parse(valid());
    expect(parsed.steps).toHaveLength(7);
    const withoutAutosend = { schemaVersion: 1, steps: [] };
    expect(procedureStepsSchema.parse(withoutAutosend).autosend).toBe('never');
    expect(procedureStepsSchema.parse(EMPTY_PROCEDURE_STEPS).steps).toEqual([]);
  });

  it('keeps the tool list in step with the generic list', () => {
    for (const name of PROCEDURE_GENERIC_TOOLS) expect(PROCEDURE_TOOL_NAMES).toContain(name);
  });

  it('refuses a field it does not know, at every level (no query, no free input)', () => {
    expect(procedureStepsSchema.safeParse({ ...valid(), extra: 1 }).success).toBe(false);
    for (const extra of [
      { query: 'severity>=ERROR' },
      { sql: 'select 1' },
      { input: { text: 'x' } },
    ]) {
      const steps = [{ kind: 'tool', id: 'logs', tool: 'gcp_logs', ...extra }];
      expect(procedureStepsSchema.safeParse({ schemaVersion: 1, steps }).success).toBe(false);
    }
    expect(
      procedureStepsSchema.safeParse({
        schemaVersion: 1,
        steps: [{ kind: 'tool', id: 'a', tool: 'gcp_logs', params: { query: 'x' } }],
      }).success,
    ).toBe(false);
  });

  it('refuses a tool that does not exist or that writes', () => {
    for (const tool of ['send_email', 'ticket_update', 'bigquery_write', '']) {
      expect(
        procedureStepsSchema.safeParse({
          schemaVersion: 1,
          steps: [{ kind: 'tool', id: 'a', tool }],
        }).success,
      ).toBe(false);
    }
  });

  it('refuses another schema version, an autosend value that is not listed and an unknown kind', () => {
    expect(
      procedureStepsSchema.safeParse(valid({ schemaVersion: 2 as unknown as 1 })).success,
    ).toBe(false);
    expect(
      procedureStepsSchema.safeParse(valid({ autosend: 'always' as unknown as 'never' })).success,
    ).toBe(false);
    expect(
      procedureStepsSchema.safeParse({ schemaVersion: 1, steps: [{ kind: 'send_reply', id: 'a' }] })
        .success,
    ).toBe(false);
  });

  it('enforces the numbers: params, step count, tool count, ids, text size', () => {
    const tool = (id: string, params?: Record<string, number | undefined>) => ({
      kind: 'tool' as const,
      id,
      tool: 'kb_search' as const,
      ...(params === undefined ? {} : { params }),
    });
    for (const params of [
      { limit: 0 },
      { limit: 21 },
      { windowMinutes: 4 },
      { windowMinutes: 1441 },
      { windowHours: 0 },
      { windowHours: 73 },
    ]) {
      expect(
        procedureStepsSchema.safeParse({ schemaVersion: 1, steps: [tool('a', params)] }).success,
      ).toBe(false);
    }
    expect(
      procedureStepsSchema.safeParse({
        schemaVersion: 1,
        steps: [tool('a', { limit: 20, windowMinutes: 5, windowHours: 72 })],
      }).success,
    ).toBe(true);

    const nine = Array.from({ length: 9 }, (_, index) => tool(`t${String(index)}`));
    expect(procedureStepsSchema.safeParse({ schemaVersion: 1, steps: nine }).success).toBe(false);
    expect(
      procedureStepsSchema.safeParse({ schemaVersion: 1, steps: nine.slice(0, 8) }).success,
    ).toBe(true);

    const twentyOne = Array.from({ length: PROCEDURE_LIMITS.maxSteps + 1 }, (_, index) => ({
      kind: 'reply_guideline' as const,
      id: `g${String(index)}`,
      text: 'x',
    }));
    expect(procedureStepsSchema.safeParse({ schemaVersion: 1, steps: twentyOne }).success).toBe(
      false,
    );

    expect(
      procedureStepsSchema.safeParse({ schemaVersion: 1, steps: [tool('a'), tool('a')] }).success,
    ).toBe(false);
    expect(procedureStepsSchema.safeParse({ schemaVersion: 1, steps: [tool('A b')] }).success).toBe(
      false,
    );

    // 9 guidelines of 1000 bytes pass the per-step caps but not the 8 KB total.
    const long = Array.from({ length: 9 }, (_, index) => ({
      kind: 'reply_guideline' as const,
      id: `g${String(index)}`,
      text: 'x'.repeat(1000),
    }));
    expect(procedureStepsSchema.safeParse({ schemaVersion: 1, steps: long }).success).toBe(false);
    expect(
      procedureStepsSchema.safeParse({ schemaVersion: 1, steps: long.slice(0, 8) }).success,
    ).toBe(true);
  });

  it('counts the bytes of the text, not the characters', () => {
    const parsed = procedureStepsSchema.parse({
      schemaVersion: 1,
      steps: [{ kind: 'reply_guideline', id: 'a', text: 'สวัสดี' }],
    });
    expect(procedureTextBytes(parsed.steps)).toBe(18);
  });

  it('wants an escalate or require_human step to say when, and a check to name its evidence', () => {
    expect(
      procedureStepsSchema.safeParse({
        schemaVersion: 1,
        steps: [{ kind: 'escalate', id: 'e', to: { role: 'head' }, note: 'x' }],
      }).success,
    ).toBe(false);
    expect(
      procedureStepsSchema.safeParse({
        schemaVersion: 1,
        steps: [{ kind: 'require_human', id: 'r', reason: 'x' }],
      }).success,
    ).toBe(false);
    expect(
      procedureStepsSchema.safeParse({
        schemaVersion: 1,
        steps: [{ kind: 'check', id: 'c', question: 'x', evidenceFrom: [] }],
      }).success,
    ).toBe(false);
  });

  it('only escalates to a queue or to lead and head', () => {
    const when = { all: [{ field: 'ticket.priority', op: 'eq', value: 'P1' }] };
    const step = (to: unknown) => ({ kind: 'escalate', id: 'e', when, note: 'x', to });
    expect(
      procedureStepsSchema.safeParse({ schemaVersion: 1, steps: [step({ queueKey: 'tier2' })] })
        .success,
    ).toBe(true);
    expect(
      procedureStepsSchema.safeParse({ schemaVersion: 1, steps: [step({ role: 'head' })] }).success,
    ).toBe(true);
    expect(
      procedureStepsSchema.safeParse({ schemaVersion: 1, steps: [step({ role: 'agent' })] })
        .success,
    ).toBe(false);
    expect(
      procedureStepsSchema.safeParse({ schemaVersion: 1, steps: [step({ userId: 'x' })] }).success,
    ).toBe(false);
  });
});

describe('conditionSchema', () => {
  const clause = (field: string, op: string, value: unknown) => ({ all: [{ field, op, value }] });

  it('checks the value against the field', () => {
    expect(conditionSchema.safeParse(clause('classifier.confidence', 'gte', 0.7)).success).toBe(
      true,
    );
    expect(conditionSchema.safeParse(clause('classifier.confidence', 'gte', 1.5)).success).toBe(
      false,
    );
    expect(conditionSchema.safeParse(clause('classifier.confidence', 'gte', '0.7')).success).toBe(
      false,
    );
    expect(conditionSchema.safeParse(clause('ticket.priority', 'eq', 'P9')).success).toBe(false);
    expect(conditionSchema.safeParse(clause('ticket.priority', 'in', ['P1', 'P2'])).success).toBe(
      true,
    );
    expect(
      conditionSchema.safeParse(clause('ticket.priority', 'in', ['P1', 'urgent'])).success,
    ).toBe(false);
    expect(conditionSchema.safeParse(clause('contact.verified', 'eq', true)).success).toBe(true);
    expect(conditionSchema.safeParse(clause('contact.verified', 'eq', 'yes')).success).toBe(false);
    expect(conditionSchema.safeParse(clause('evidence.count', 'gte', 1.5)).success).toBe(false);
    expect(conditionSchema.safeParse(clause('evidence.count', 'gte', -1)).success).toBe(false);
    expect(conditionSchema.safeParse(clause('org.tier', 'eq', 'Enterprise Plus')).success).toBe(
      false,
    );
  });

  it('refuses an operator the field does not take, an unknown field and an expression string', () => {
    expect(conditionSchema.safeParse(clause('contact.verified', 'gte', true)).success).toBe(false);
    expect(conditionSchema.safeParse(clause('ticket.priority', 'gte', 'P1')).success).toBe(false);
    expect(conditionSchema.safeParse(clause('ticket.subject', 'eq', 'x')).success).toBe(false);
    expect(conditionSchema.safeParse('ticket.priority == "P1"').success).toBe(false);
    expect(conditionSchema.safeParse({}).success).toBe(false);
    expect(conditionSchema.safeParse({ all: [] }).success).toBe(false);
    expect(
      conditionSchema.safeParse({
        all: [{ field: 'evidence.count', op: 'eq', value: 1, extra: 1 }],
      }).success,
    ).toBe(false);
  });

  it('names exactly the eight fields of ADR-026', () => {
    expect(Object.keys(CONDITION_FIELDS).toSorted()).toEqual(
      [
        'classifier.confidence',
        'contact.verified',
        'evidence.count',
        'investigation.hasLikelyCause',
        'org.tier',
        'ticket.channel',
        'ticket.priority',
        'ticket.reopenCount',
      ].toSorted(),
    );
  });
});

describe('evaluateCondition', () => {
  const cond = (value: unknown): Condition => conditionSchema.parse(value);

  it('is true with no condition', () => {
    expect(evaluateCondition(undefined, {})).toBe(true);
  });

  it('applies each operator', () => {
    const facts = {
      'classifier.confidence': 0.8,
      'ticket.priority': 'P2',
      'evidence.count': 3,
      'contact.verified': false,
    };
    expect(
      evaluateCondition(
        cond({ all: [{ field: 'classifier.confidence', op: 'gte', value: 0.8 }] }),
        facts,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        cond({ all: [{ field: 'classifier.confidence', op: 'lte', value: 0.79 }] }),
        facts,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        cond({ all: [{ field: 'ticket.priority', op: 'eq', value: 'P2' }] }),
        facts,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        cond({ all: [{ field: 'ticket.priority', op: 'neq', value: 'P2' }] }),
        facts,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        cond({ all: [{ field: 'ticket.priority', op: 'in', value: ['P1', 'P2'] }] }),
        facts,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        cond({ all: [{ field: 'ticket.priority', op: 'in', value: ['P3'] }] }),
        facts,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        cond({ all: [{ field: 'contact.verified', op: 'eq', value: false }] }),
        facts,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(cond({ all: [{ field: 'evidence.count', op: 'eq', value: 3 }] }), facts),
    ).toBe(true);
  });

  it('combines all (and), any (or) and both', () => {
    const facts = { 'ticket.priority': 'P1', 'evidence.count': 0, 'ticket.reopenCount': 0 };
    const p1 = { field: 'ticket.priority', op: 'eq', value: 'P1' };
    const some = { field: 'evidence.count', op: 'gte', value: 1 };
    const reopened = { field: 'ticket.reopenCount', op: 'gte', value: 1 };
    expect(evaluateCondition(cond({ all: [p1, some] }), facts)).toBe(false);
    expect(evaluateCondition(cond({ any: [p1, some] }), facts)).toBe(true);
    expect(evaluateCondition(cond({ any: [some, reopened] }), facts)).toBe(false);
    expect(evaluateCondition(cond({ all: [p1], any: [some, reopened] }), facts)).toBe(false);
    expect(evaluateCondition(cond({ all: [p1], any: [some, p1] }), facts)).toBe(true);
  });

  it('takes the safe side for a fact that is not known, as the caller says', () => {
    const c = cond({ all: [{ field: 'classifier.confidence', op: 'gte', value: 0.5 }] });
    expect(evaluateCondition(c, {})).toBe(false);
    expect(evaluateCondition(c, { 'classifier.confidence': null })).toBe(false);
    expect(evaluateCondition(c, {}, { unknown: true })).toBe(true);
    // A type that does not fit the operator never holds, even where unknown is true.
    expect(evaluateCondition(c, { 'classifier.confidence': 'high' }, { unknown: true })).toBe(
      false,
    );
    const neq = cond({ all: [{ field: 'ticket.priority', op: 'neq', value: 'P1' }] });
    expect(evaluateCondition(neq, {})).toBe(false);
  });
});

describe('procedure permissions', () => {
  it('lead and head write and publish; agent and dev only read; client nothing', () => {
    const has = (role: keyof typeof DEFAULT_ROLE_PERMISSIONS, permission: string) =>
      (DEFAULT_ROLE_PERMISSIONS[role] as readonly string[]).includes(permission);
    for (const role of ['lead', 'head'] as const) {
      expect(
        has(role, 'procedure.read') &&
          has(role, 'procedure.author') &&
          has(role, 'procedure.publish'),
      ).toBe(true);
    }
    for (const role of ['agent', 'dev'] as const) {
      expect(has(role, 'procedure.read')).toBe(true);
      expect(has(role, 'procedure.author') || has(role, 'procedure.publish')).toBe(false);
    }
    for (const role of ['client', 'system'] as const)
      expect(has(role, 'procedure.read')).toBe(false);
  });
});
