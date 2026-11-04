import { procedureStepsSchema, type ProcedureStep, type ProcedureSteps } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import {
  diffProcedure,
  freshStepId,
  localIssues,
  moveStep,
  newStep,
  removeStep,
  renameStepId,
  sameSteps,
  STEP_KINDS,
} from './procedure-edit';

const tool = (id: string): ProcedureStep => ({ kind: 'tool', id, tool: 'kb_search' });
const steps = (list: ProcedureStep[], autosend: 'never' | 'allowed' = 'never'): ProcedureSteps => ({
  schemaVersion: 1,
  autosend,
  steps: list,
});

describe('new steps', () => {
  it('numbers ids so none repeats', () => {
    expect(freshStepId('check', [])).toBe('check_1');
    expect(freshStepId('check', [{ ...tool('check_1') }])).toBe('check_2');
  });

  it('starts every kind in a shape the schema can read once the person fills the text', () => {
    const base: ProcedureStep[] = [tool('t1')];
    for (const kind of STEP_KINDS) {
      const step = newStep(kind, base);
      // Empty text is the only thing the schema refuses on a fresh step.
      const result = procedureStepsSchema.safeParse(steps([...base, step]));
      const messages = result.success
        ? []
        : result.error.issues.map((issue) => issue.path.join('.'));
      for (const path of messages) expect(path).toMatch(/(question|text|topic|note|reason)$/);
    }
  });

  it('points a new check at the first tool step', () => {
    const step = newStep('check', [tool('look')]);
    expect(step.kind === 'check' && step.evidenceFrom).toEqual(['look']);
  });
});

describe('editing the list', () => {
  it('moves a step and leaves the ends alone', () => {
    expect(moveStep(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveStep(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
    expect(moveStep(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
  });

  it('carries a rename into the evidence of a check', () => {
    const check: ProcedureStep = { kind: 'check', id: 'c1', question: 'q', evidenceFrom: ['t1'] };
    const next = renameStepId([tool('t1'), check], 't1', 't2');
    expect(next[0]?.id).toBe('t2');
    expect(next[1]?.kind === 'check' && next[1].evidenceFrom).toEqual(['t2']);
  });

  it('drops a removed step from the evidence of a check', () => {
    const check: ProcedureStep = {
      kind: 'check',
      id: 'c1',
      question: 'q',
      evidenceFrom: ['t1', 't2'],
    };
    const next = removeStep([tool('t1'), tool('t2'), check], 't1');
    expect(next.map((step) => step.id)).toEqual(['t2', 'c1']);
    expect(next[1]?.kind === 'check' && next[1].evidenceFrom).toEqual(['t2']);
  });
});

describe('diff against the live version', () => {
  it('says every step is added when nothing is live', () => {
    const diff = diffProcedure(null, steps([tool('a'), tool('b')]));
    expect(diff.changes.map((change) => change.type)).toEqual(['added', 'added']);
    expect(diff.autosendChanged).toBe(false);
  });

  it('finds added, removed, changed and moved steps by id', () => {
    const live = steps([
      tool('a'),
      tool('b'),
      { kind: 'reply_guideline', id: 'g', text: 'one' },
      tool('d'),
    ]);
    const next = steps([
      tool('d'),
      tool('a'),
      { kind: 'reply_guideline', id: 'g', text: 'two' },
      tool('e'),
    ]);
    const byId = Object.fromEntries(diffProcedure(live, next).changes.map((c) => [c.id, c]));
    expect(byId.b?.type).toBe('removed');
    expect(byId.e?.type).toBe('added');
    expect(byId.g).toMatchObject({ type: 'changed', fields: ['text'] });
    expect(byId.d?.type).toBe('moved');
  });

  it('reports a change of the sending rule and no change at all', () => {
    const live = steps([tool('a')]);
    expect(diffProcedure(live, steps([tool('a')], 'allowed')).autosendChanged).toBe(true);
    expect(diffProcedure(live, steps([tool('a')]))).toEqual({
      autosendChanged: false,
      changes: [],
    });
  });

  it('does not see a key order or an absent optional field as a change', () => {
    const a: ProcedureStep = { kind: 'tool', id: 'a', tool: 'kb_search', params: { limit: 5 } };
    const b: ProcedureStep = {
      kind: 'tool',
      id: 'a',
      tool: 'kb_search',
      template: undefined,
      params: { limit: 5 },
    };
    expect(diffProcedure(steps([a]), steps([b])).changes).toEqual([]);
    expect(sameSteps(steps([a]), steps([b]))).toBe(true);
  });
});

describe('local schema check', () => {
  it('is quiet for steps that fit', () => {
    expect(localIssues(steps([tool('a')]))).toEqual([]);
  });

  it('puts a problem on the step it is in, and one about the list on no step', () => {
    const issues = localIssues(
      steps([tool('a'), { kind: 'reply_guideline', id: 'g', text: '' }, tool('a')]),
    );
    expect(issues.some((issue) => issue.stepId === 'g' && issue.message.startsWith('text'))).toBe(
      true,
    );
    expect(issues.length).toBeGreaterThan(0);
  });
});
