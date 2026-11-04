import { procedureStepsSchema, type Condition, type ProcedureStepsInput } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { validateProcedureSteps, type ProcedureValidationContext } from './validate.js';

const CONTEXT: ProcedureValidationContext = {
  allowedTools: ['gcp_logs', 'bigquery_query'],
  templates: [
    { name: 'errors_last_hour', kind: 'logs' },
    { name: 'plan_rows', kind: 'data' },
  ],
  queueKeys: ['Tier 2', 'billing'],
};

const check = (steps: ProcedureStepsInput['steps'], context = CONTEXT) =>
  validateProcedureSteps(procedureStepsSchema.parse({ schemaVersion: 1, steps }), context);
const codes = (steps: ProcedureStepsInput['steps'], context = CONTEXT) =>
  check(steps, context).issues.map((issue) => issue.code);

describe('validateProcedureSteps', () => {
  it('passes a procedure whose tools, templates and queues exist', () => {
    const result = check([
      { kind: 'tool', id: 'kb', tool: 'kb_search' },
      { kind: 'tool', id: 'logs', tool: 'gcp_logs', template: 'errors_last_hour' },
      { kind: 'tool', id: 'rows', tool: 'bigquery_query', template: 'plan_rows' },
      { kind: 'check', id: 'c', question: 'Is it an outage?', evidenceFrom: ['logs', 'rows'] },
      {
        kind: 'escalate',
        id: 'e',
        when: { all: [{ field: 'ticket.priority', op: 'eq', value: 'P1' }] },
        to: { queueKey: 'tier 2' },
        note: 'Page tier 2.',
      },
    ]);
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it('refuses a tool the intent is not allowed to use, but not the generic ones', () => {
    const context = { ...CONTEXT, allowedTools: [] };
    expect(codes([{ kind: 'tool', id: 'a', tool: 'gcp_logs' }], context)).toEqual([
      'tool_not_allowed',
    ]);
    expect(codes([{ kind: 'tool', id: 'a', tool: 'repo_changes' }], context)).toEqual([
      'tool_not_allowed',
    ]);
    expect(
      codes(
        [
          { kind: 'tool', id: 'a', tool: 'kb_search' },
          { kind: 'tool', id: 'b', tool: 'similar_tickets' },
          { kind: 'tool', id: 'c', tool: 'org_context' },
        ],
        context,
      ),
    ).toEqual([]);
  });

  it('wants a template that exists, of the right kind, on a tool that takes one', () => {
    expect(codes([{ kind: 'tool', id: 'a', tool: 'gcp_logs', template: 'nothing' }])).toEqual([
      'template_not_found',
    ]);
    expect(codes([{ kind: 'tool', id: 'a', tool: 'gcp_logs', template: 'plan_rows' }])).toEqual([
      'template_wrong_tool',
    ]);
    expect(
      codes([{ kind: 'tool', id: 'a', tool: 'kb_search', template: 'errors_last_hour' }]),
    ).toEqual(['template_not_for_tool']);
  });

  it('wants the queue of an escalation to exist', () => {
    const when: Condition = { all: [{ field: 'ticket.priority', op: 'eq', value: 'P1' }] };
    expect(
      codes([{ kind: 'escalate', id: 'e', when, to: { queueKey: 'ghost' }, note: 'x' }]),
    ).toEqual(['queue_not_found']);
    expect(codes([{ kind: 'escalate', id: 'e', when, to: { role: 'head' }, note: 'x' }])).toEqual(
      [],
    );
  });

  it('wants a check to read from earlier tool steps', () => {
    expect(codes([{ kind: 'check', id: 'c', question: 'x', evidenceFrom: ['ghost'] }])).toEqual([
      'evidence_unknown_step',
    ]);
    expect(
      codes([
        { kind: 'check', id: 'c', question: 'x', evidenceFrom: ['kb'] },
        { kind: 'tool', id: 'kb', tool: 'kb_search' },
      ]),
    ).toEqual(['evidence_not_earlier']);
    expect(
      codes([
        { kind: 'reply_guideline', id: 'g', text: 'x' },
        { kind: 'check', id: 'c', question: 'x', evidenceFrom: ['g'] },
      ]),
    ).toEqual(['evidence_not_tool']);
  });

  it('finds a step that can never run', () => {
    expect(
      codes([
        {
          kind: 'tool',
          id: 'a',
          tool: 'kb_search',
          when: {
            all: [
              { field: 'ticket.priority', op: 'eq', value: 'P1' },
              { field: 'ticket.priority', op: 'eq', value: 'P2' },
            ],
          },
        },
      ]),
    ).toEqual(['contradictory_condition']);
    expect(
      codes([
        {
          kind: 'require_human',
          id: 'r',
          reason: 'x',
          when: {
            all: [
              { field: 'evidence.count', op: 'gte', value: 5 },
              { field: 'evidence.count', op: 'lte', value: 2 },
            ],
          },
        },
      ]),
    ).toEqual(['contradictory_condition']);
    expect(
      codes([
        {
          kind: 'require_human',
          id: 'r',
          reason: 'x',
          when: {
            all: [
              { field: 'contact.verified', op: 'eq', value: true },
              { field: 'contact.verified', op: 'neq', value: true },
            ],
          },
        },
      ]),
    ).toEqual(['contradictory_condition']);
    // "any" is not a contradiction: either clause may hold.
    expect(
      codes([
        {
          kind: 'require_human',
          id: 'r',
          reason: 'x',
          when: {
            any: [
              { field: 'ticket.priority', op: 'eq', value: 'P1' },
              { field: 'ticket.priority', op: 'eq', value: 'P2' },
            ],
          },
        },
      ]),
    ).toEqual([]);
  });

  it('finds a check whose evidence never runs where the check does, and a repeated tool step', () => {
    expect(
      codes([
        { kind: 'tool', id: 'kb', tool: 'kb_search', stages: [0] },
        { kind: 'check', id: 'c', question: 'x', evidenceFrom: ['kb'], stages: [2] },
      ]),
    ).toEqual(['dead_step']);
    expect(
      codes([
        { kind: 'tool', id: 'kb', tool: 'kb_search', stages: [1, 2] },
        { kind: 'check', id: 'c', question: 'x', evidenceFrom: ['kb'], stages: [2] },
      ]),
    ).toEqual([]);
    expect(
      codes([
        { kind: 'tool', id: 'a', tool: 'kb_search', params: { limit: 3 } },
        { kind: 'tool', id: 'b', tool: 'kb_search', params: { limit: 3 } },
      ]),
    ).toEqual(['duplicate_tool_step']);
    expect(
      codes([
        { kind: 'tool', id: 'a', tool: 'kb_search', params: { limit: 3 } },
        { kind: 'tool', id: 'b', tool: 'kb_search', params: { limit: 5 } },
      ]),
    ).toEqual([]);
  });

  it('lists every problem in one pass, with the step each belongs to', () => {
    const result = check([
      { kind: 'tool', id: 'a', tool: 'repo_changes' },
      { kind: 'check', id: 'c', question: 'x', evidenceFrom: ['ghost'] },
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => [issue.code, issue.stepId])).toEqual([
      ['tool_not_allowed', 'a'],
      ['evidence_unknown_step', 'c'],
    ]);
  });
});
