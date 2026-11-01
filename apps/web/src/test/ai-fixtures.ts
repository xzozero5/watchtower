import type { AiReport, TicketAiInsight } from '@watchtower/shared';

/** The id of the draft in the fixtures: a UUID, as the api sends (a reply carries it as `aiDraftId`). */
export const DRAFT_ID = 'd0000000-0000-4000-8000-000000000001';

/**
 * Realistic, fictional AI briefs for tests and e2e (T-128). Nothing in the app produces these yet:
 * the api serves `GET /v1/tickets/:id/ai` with T-106e / T-108, so tests mock it (the UI never makes
 * AI content up, N5). Everything here is invented (example.com, Riley, Example Org).
 */
export function makeInsight(overrides: Partial<TicketAiInsight> = {}): TicketAiInsight {
  return {
    state: 'draft_ready',
    summary: 'Cannot sign in after a reset; the account looks locked.',
    intent: {
      key: 'login_issue',
      confidence: 0.86,
      reason: 'Same wording as 12 earlier lockout tickets.',
    },
    nextStep: { kind: 'approve_draft', label: 'Approve reply' },
    evidence: [
      {
        id: 'ev-kb-1',
        kind: 'kb',
        title: 'Unlocking an account after failed sign-ins',
        snippet: 'An account unlocks by itself 15 minutes after the last failed attempt.',
        confidence: 0.91,
        href: 'https://docs.example.com/kb/unlock-account',
      },
      {
        id: 'ev-ticket-1',
        kind: 'ticket',
        title: 'OPS-1180 Locked out after reset',
        snippet: 'Resolved by waiting for the lock to expire and resetting once more.',
        confidence: 0.64,
        href: '/?ticket=OPS-1180',
      },
    ],
    draft: {
      id: DRAFT_ID,
      body: 'Hello Riley, your account was locked after several sign-in attempts [1]. It unlocks by itself after 15 minutes; please reset once more after that [2].',
      citations: ['ev-kb-1', 'ev-ticket-1'],
      uncitedClaims: 0,
      promptVersion: 'v3',
      createdAt: '2026-11-02T02:58:00.000Z',
    },
    stage: 2,
    generatedAt: '2026-11-02T02:58:00.000Z',
    ...overrides,
  };
}

/** The same ticket in Thai, for the Thai-locale screens. */
export function makeInsightTh(): TicketAiInsight {
  return makeInsight({
    summary: 'เข้าสู่ระบบไม่ได้หลังรีเซ็ต บัญชีน่าจะถูกล็อก',
    intent: {
      key: 'login_issue',
      confidence: 0.86,
      reason: 'ถ้อยคำเหมือน ticket บัญชีถูกล็อก 12 รายการก่อนหน้า',
    },
    nextStep: { kind: 'approve_draft', label: 'อนุมัติคำตอบ' },
    evidence: [
      {
        id: 'ev-kb-1',
        kind: 'kb',
        title: 'ปลดล็อกบัญชีหลังเข้าสู่ระบบผิดหลายครั้ง',
        snippet: 'บัญชีจะปลดล็อกเองหลังความพยายามผิดครั้งสุดท้าย 15 นาที',
        confidence: 0.91,
        href: 'https://docs.example.com/kb/unlock-account',
      },
    ],
    draft: {
      id: DRAFT_ID,
      body: 'สวัสดีค่ะ คุณไรลีย์ บัญชีของคุณถูกล็อกหลังพยายามเข้าสู่ระบบหลายครั้ง [1] ระบบจะปลดล็อกให้เองใน 15 นาที จากนั้นกรุณารีเซ็ตอีกครั้ง',
      citations: ['ev-kb-1'],
      uncitedClaims: 1,
      promptVersion: 'v3',
      createdAt: '2026-11-02T02:58:00.000Z',
    },
  });
}

/** Low confidence: the AI is not sure of the intent, nothing to approve yet. */
export function makeLowConfidenceInsight(): TicketAiInsight {
  const insight = makeInsight();
  delete insight.draft;
  return {
    ...insight,
    state: 'needs_human',
    summary: 'Export fails for one customer; could be a quota or a permissions problem.',
    intent: { key: 'export_issue', confidence: 0.31, reason: 'Two intents fit equally well.' },
    nextStep: { kind: 'reply', label: 'Ask for the export ID' },
    evidence: [],
  };
}

/** A draft with a sentence no evidence supports. */
export function makeUncitedInsight(): TicketAiInsight {
  const base = makeInsight();
  return makeInsight({
    draft: base.draft
      ? {
          ...base.draft,
          body: 'Hello Riley, the lock clears after 15 minutes [1]. The fix ships tonight.',
          citations: ['ev-kb-1'],
          uncitedClaims: 1,
        }
      : undefined,
  });
}

/** The AI is still working: a state and a summary, no draft yet. */
export function makeInvestigatingInsight(): TicketAiInsight {
  const insight = makeInsight();
  delete insight.draft;
  return {
    ...insight,
    state: 'investigating',
    summary: 'Webhook deliveries failing for one customer since this morning.',
    nextStep: undefined,
    intent: {
      key: 'webhook_failure',
      confidence: 0.72,
      reason: 'Matches a delivery error signature.',
    },
    evidence: [],
  };
}

/** An investigation report: one finding with evidence, one without, a tool that was refused. */
export function makeReport(overrides: Partial<AiReport> = {}): AiReport {
  return {
    findings: [
      { text: 'The account was locked after five failed sign-ins.', evidenceIds: ['ev-kb-1'] },
      { text: 'The reset email was delivered twice.', evidenceIds: [] },
    ],
    likelyCause: 'A lockout policy, not a bug in the reset flow.',
    confidence: 0.82,
    openQuestions: ['Did the customer use the second reset link?'],
    tools: [
      { name: 'kb_search', status: 'ok', mock: false },
      { name: 'gcp_logs', status: 'denied', mock: true },
    ],
    promptVersion: 'v3',
    scope: { intent: 'login_issue', basis: 'confidence' },
    ...overrides,
  };
}

/** The same brief while the worker is still running: a step, not a spinner. */
export function makeProgressInsight(step = 1, steps = 4): TicketAiInsight {
  const insight = makeInvestigatingInsight();
  return { ...insight, progress: { phase: 'investigating', step, steps } };
}
