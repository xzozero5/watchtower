import { expect, it } from 'vitest';
import * as legacy from './bridge.mjs';
import * as canonical from '../ai-bridge/bridge.mjs';

it('keeps the legacy bridge exports compatible with the canonical bridge', () => {
  expect(legacy.createBridge).toBe(canonical.createBridge);
  expect(legacy.resolveClaudeBinary).toBe(canonical.resolveClaudeBinary);
});
