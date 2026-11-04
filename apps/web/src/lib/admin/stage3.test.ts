import { describe, expect, it } from 'vitest';

import { makeGateReport, makePromotion } from '@/test/stage3-fixtures';

import {
  approveReturnPath,
  heldReasonCode,
  heldReasonKey,
  promotionBlock,
  shadowMetrics,
} from './stage3';

const base = {
  autosendFlag: true,
  stage: 2,
  pinned: false,
  latestReport: makeGateReport('green'),
  openPromotion: null,
};

describe('promotionBlock', () => {
  it('is open only when the flag is on and the latest report is green', () => {
    expect(promotionBlock(base)).toBeNull();
  });

  it('puts the instance switch first, whatever else is true', () => {
    expect(promotionBlock({ ...base, autosendFlag: false, latestReport: null })).toBe('flag_off');
  });

  it.each([
    ['red', 'not_green'],
    ['insufficient_data', 'insufficient_data'],
  ] as const)('a %s report blocks as %s', (status, block) => {
    expect(promotionBlock({ ...base, latestReport: makeGateReport(status) })).toBe(block);
  });

  it('blocks with no report, below stage 2, a pinned stage, an open request and stage 3', () => {
    expect(promotionBlock({ ...base, latestReport: null })).toBe('no_report');
    expect(promotionBlock({ ...base, stage: 1 })).toBe('below_stage_2');
    expect(promotionBlock({ ...base, pinned: true })).toBe('pinned');
    expect(promotionBlock({ ...base, openPromotion: makePromotion() })).toBe('request_open');
    expect(promotionBlock({ ...base, stage: 3 })).toBe('already_stage3');
  });
});

describe('held reasons', () => {
  it('knows the codes of the gate and not the others', () => {
    expect(heldReasonKey('customer_wants_human')).toBe('stage3.held.customer_wants_human');
    expect(heldReasonKey('toString')).toBeNull();
    expect(heldReasonKey('nope')).toBeNull();
  });

  it('reads the reason, else the first failed check', () => {
    expect(heldReasonCode({ reason: 'too_long' })).toBe('too_long');
    expect(heldReasonCode({ failed: ['has_attachment', 'too_long'] })).toBe('has_attachment');
    expect(heldReasonCode({})).toBeNull();
  });
});

describe('shadowMetrics and the return address', () => {
  it('reads the shadow block of a report', () => {
    expect(shadowMetrics(makeGateReport('green'))).toEqual({
      evaluations: 60,
      decided: 50,
      accepted: 47,
      precision: 0.94,
    });
    expect(shadowMetrics(makeGateReport('green', { metrics: {} }))).toBeNull();
    expect(shadowMetrics(null)).toBeNull();
  });

  it('brings the owner back to the Stage 3 tab with the request to approve', () => {
    expect(approveReturnPath('abc', 'def')).toBe('/admin/intents/abc?tab=stage3&approve=def');
  });
});
