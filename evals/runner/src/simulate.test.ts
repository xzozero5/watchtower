import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createRig } from './rig.js';
import {
  formatSimulation,
  parseStepsFile,
  simulateFixture,
  simulationFixtureSchema,
} from './simulate.js';

const read = (name: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../simulation/${name}`, import.meta.url)), 'utf8'),
  );

const cases = simulationFixtureSchema.parse(read('smoke.json')).cases;
const steps = parseStepsFile(read('smoke-steps.json'));
const rig = (maxCalls = 200) => createRig({ provider: 'mock', maxCalls, env: {} });

describe('simulate on fixtures (T-303d)', () => {
  it('parses the fixture files with the strict schemas', () => {
    expect(cases).toHaveLength(2);
    expect(steps.steps.map((step) => step.kind)).toEqual([
      'tool',
      'tool',
      'check',
      'reply_guideline',
      'disclosure',
    ]);
    // A step the schema does not know is refused, as the api refuses it.
    expect(() =>
      parseStepsFile({ schemaVersion: 1, steps: [{ kind: 'tool', id: 'x', tool: 'shell' }] }),
    ).toThrow();
  });

  it('runs the engine offline on the mock provider and says what it measured', async () => {
    const outcome = await simulateFixture({ rig: rig(), cases, steps });
    if (outcome.status !== 'ok') throw new Error(`stopped: ${outcome.reason}`);
    expect(outcome.metrics.mode).toBe('fixture');
    expect(outcome.metrics.caseCount).toBe(2);
    expect(outcome.metrics.baselineVersionId).toBeNull();
    expect(outcome.metrics.toolCalls).toBeGreaterThan(0);
    expect(outcome.metrics.cases.map((item) => item.ticketId)).toHaveLength(2);
    expect(formatSimulation(outcome)).toContain('simulation (fixture):');
    // The verdict agrees with the reasons it lists.
    expect(outcome.passed).toBe(outcome.metrics.failReasons.length === 0);
  });

  it('stops with no verdict at the budget guard of the run', async () => {
    const outcome = await simulateFixture({ rig: rig(1), cases, steps });
    expect(outcome.status).toBe('stopped');
    expect(formatSimulation(outcome)).toContain('no verdict');
  });
});
