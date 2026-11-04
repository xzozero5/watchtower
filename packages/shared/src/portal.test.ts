import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CUSTOMER_STATUS_LABELS,
  PORTAL_CATEGORIES,
  PORTAL_CATEGORY_INTENT_HINT,
  PORTAL_URGENCIES,
  PORTAL_URGENCY_PRIORITY,
  customerStatus,
  decodePortalProof,
  encodePortalProof,
  emailJobSchema,
  humanChallengeSchema,
  leadingZeroBits,
  maskEmail,
  portalSubmitSchema,
  portalTrackingPath,
  powInput,
  TICKET_STATUSES,
} from './index.js';

describe('customerStatus (UI spec section 10)', () => {
  it('maps every internal status to the words a customer sees', () => {
    expect(Object.fromEntries(TICKET_STATUSES.map((s) => [s, customerStatus(s)]))).toEqual({
      new: 'received',
      triage: 'in_progress',
      open: 'in_progress',
      waiting_on_dev: 'in_progress',
      waiting_on_customer: 'waiting_for_you',
      resolved: 'resolved',
      closed: 'closed',
      merged: 'merged',
    });
  });

  it('has an English label for each word', () => {
    expect(CUSTOMER_STATUS_LABELS.received).toBe('Received');
    expect(CUSTOMER_STATUS_LABELS.in_progress).toBe('In progress');
    expect(CUSTOMER_STATUS_LABELS.waiting_for_you).toBe('Waiting for your reply');
    expect(CUSTOMER_STATUS_LABELS.resolved).toBe('Resolved');
    expect(CUSTOMER_STATUS_LABELS.closed).toBe('Closed');
  });
});

describe('form vocabulary', () => {
  it('gives every category an intent hint and every urgency a priority', () => {
    for (const category of PORTAL_CATEGORIES) {
      expect(PORTAL_CATEGORY_INTENT_HINT[category]).toMatch(/^[a-z][a-z_]+$/);
    }
    expect(PORTAL_URGENCIES.map((u) => PORTAL_URGENCY_PRIORITY[u])).toEqual(['P1', 'P2', 'P3']);
  });
});

describe('proof-of-work helpers', () => {
  it('counts leading zero bits', () => {
    expect(leadingZeroBits(Uint8Array.of(0xff))).toBe(0);
    expect(leadingZeroBits(Uint8Array.of(0x7f))).toBe(1);
    expect(leadingZeroBits(Uint8Array.of(0x01))).toBe(7);
    expect(leadingZeroBits(Uint8Array.of(0x00, 0x80))).toBe(8);
    expect(leadingZeroBits(Uint8Array.of(0x00, 0x00, 0x0f))).toBe(20);
    expect(leadingZeroBits(Uint8Array.of(0, 0))).toBe(16);
  });

  it('hashes challenge:nonce and the browser can reproduce it', () => {
    expect(powInput('abc', '42')).toBe('abc:42');
    const digest = createHash('sha256').update(powInput('abc', '42')).digest();
    expect(leadingZeroBits(digest)).toBeGreaterThanOrEqual(0);
  });
});

describe('portalSubmitSchema', () => {
  const valid = {
    email: ' Someone@Example.COM ',
    name: 'Someone',
    category: 'api_error',
    description: 'It broke',
    verification: { provider: 'pow-sha256', challenge: 'c', nonce: '17' },
  };

  it('normalizes the email and accepts a minimal form', () => {
    const parsed = portalSubmitSchema.parse(valid);
    expect(parsed.email).toBe('someone@example.com');
  });

  it('refuses unknown fields (attachments are not accepted until T-102)', () => {
    expect(portalSubmitSchema.safeParse({ ...valid, attachments: [] }).success).toBe(false);
  });

  it('refuses a bad nonce, a long description and request ids with odd characters', () => {
    expect(
      portalSubmitSchema.safeParse({
        ...valid,
        verification: { provider: 'pow-sha256', challenge: 'c', nonce: '1e9' },
      }).success,
    ).toBe(false);
    expect(
      portalSubmitSchema.safeParse({ ...valid, description: 'x'.repeat(10_001) }).success,
    ).toBe(false);
    expect(
      portalSubmitSchema.safeParse({ ...valid, affectedRequestIds: ['ok-1', 'no spaces'] }).success,
    ).toBe(false);
    expect(
      portalSubmitSchema.safeParse({ ...valid, affectedRequestIds: Array(11).fill('a') }).success,
    ).toBe(false);
  });
});

describe('shared helpers', () => {
  it('masks an address but keeps the domain', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com');
    expect(maskEmail('nobody')).toBe('***');
  });

  it('builds the tracking path from the ticket key', () => {
    expect(portalTrackingPath('OPS-12')).toBe('/portal/tickets/OPS-12');
  });

  it('validates the portal email jobs and rejects an unknown locale', () => {
    const base = {
      to: 'a@example.com',
      locale: 'en',
      ticketKey: 'OPS-1',
      subject: 'Hello',
      trackingUrl: 'http://localhost:3000/portal/tickets/OPS-1#token=x',
    };
    expect(
      emailJobSchema.safeParse({
        kind: 'portal_confirmation',
        ...base,
        expectedFirstResponseAt: null,
      }).success,
    ).toBe(true);
    expect(
      emailJobSchema.safeParse({
        kind: 'portal_confirmation',
        ...base,
        locale: 'fr',
        expectedFirstResponseAt: null,
      }).success,
    ).toBe(false);
  });

  it('describes the challenge with a provider tag', () => {
    expect(
      humanChallengeSchema.safeParse({
        provider: 'pow-sha256',
        challenge: 'x',
        difficultyBits: 18,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
        minFillSeconds: 3,
      }).success,
    ).toBe(true);
  });
});

describe('the proof header (T-154)', () => {
  const proof = { provider: 'pow-sha256' as const, challenge: 'a.b/c+d==', nonce: '12345' };

  it('round-trips through a header-safe value', () => {
    const header = encodePortalProof(proof);
    expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodePortalProof(header)).toEqual(proof);
  });

  it('refuses anything that is not a proof, without throwing', () => {
    for (const bad of [
      '',
      'not a proof',
      '!!!',
      'e30',
      'x'.repeat(2000),
      btoa('{"provider":"x"}'),
    ]) {
      expect(decodePortalProof(bad)).toBeNull();
    }
  });
});
