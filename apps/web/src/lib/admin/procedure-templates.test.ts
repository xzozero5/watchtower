import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  procedureStepsSchema,
  PROCEDURE_LIMITS,
  PROCEDURE_GENERIC_TOOLS,
} from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { PROCEDURE_TEMPLATES } from './procedure-templates';

const DIR = join(process.cwd(), '..', '..', 'examples', 'procedures');
const files = readdirSync(DIR).filter((name) => name.endsWith('.json'));

describe('starter procedures', () => {
  it('has the same templates as examples/procedures', () => {
    const byKey = (list: readonly { key: string }[]) =>
      [...list].sort((x, y) => x.key.localeCompare(y.key));
    const fromFiles = files.map(
      (name) => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as { key: string },
    );
    expect(byKey(PROCEDURE_TEMPLATES)).toEqual(byKey(fromFiles));
    expect(files).toHaveLength(PROCEDURE_TEMPLATES.length);
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it.each(PROCEDURE_TEMPLATES.map((template) => [template.key, template] as const))(
    '%s fits the step schema, stays small, uses generic tools and never auto-sends',
    (_key, template) => {
      expect(procedureStepsSchema.safeParse(template.steps).success).toBe(true);
      expect(new TextEncoder().encode(template.sourceMd).length).toBeLessThanOrEqual(
        PROCEDURE_LIMITS.maxSourceBytes,
      );
      expect(template.steps.autosend).toBe('never');
      for (const step of template.steps.steps) {
        if (step.kind === 'tool') expect(PROCEDURE_GENERIC_TOOLS).toContain(step.tool);
      }
    },
  );

  it('names no organization (N1)', () => {
    const text = JSON.stringify(PROCEDURE_TEMPLATES).toLowerCase();
    expect(text).not.toMatch(/https?:\/\/|@[a-z0-9-]+\./);
  });
});
