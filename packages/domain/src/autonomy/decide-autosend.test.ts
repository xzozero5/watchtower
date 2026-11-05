import type { AuditActorType } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { SEND_ORIGINS } from '../policy.js';
import {
  AUTOSEND_MAX_STREAK,
  GATE_REASONS,
  ORIGIN_ACTOR,
  SHADOW_WAIVERS,
  decide,
  decideAutoSend,
  effectiveStage,
  evaluateAutoSend,
  type AutoSendFacts,
  type DecisionInput,
  type GateReason,
  type IntentStanding,
  type SwitchState,
} from './decide.js';
import { SAFE_AUTO_ACK_TEMPLATES } from './safe-templates.js';

// ADR-025 section 4 and 11: the property tests of the automatic send. The facts here are plain data; the
// loader that reads them from the tables is tested against a real database in autosend.integration.test.ts.

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACTORS: readonly AuditActorType[] = ['user', 'system', 'ai', 'anonymous'];
const SWITCHES: readonly SwitchState[] = [
  { stageCapPinned: false, killSwitch: false },
  { stageCapPinned: true, killSwitch: false },
  { stageCapPinned: false, killSwitch: true },
  { stageCapPinned: true, killSwitch: true },
];
const INTENTS: readonly IntentStanding[] = [
  { kind: 'none' },
  { kind: 'missing' },
  ...[-1, 0, 1, 2, 3, 4, 5, 1.5].map((stage) => ({ kind: 'found' as const, stage })),
];

/** A group of facts a test breaks one field of: it is there by construction. */
function need<T>(value: T | null): T {
  if (value === null) throw new Error('the fact is missing from the fixture');
  return value;
}

/** Every condition satisfied. */
const GOOD: AutoSendFacts = {
  flagOn: true,
  grade: {
    hashMatches: true,
    ageSeconds: 30,
    passed: true,
    violationCount: 0,
    score: 0.95,
    minScore: 0.85,
    mock: false,
    independent: true,
    runsKnown: true,
  },
  disclosure: { contactVerified: true, senderAuthenticated: true },
  content: {
    channel: 'gmail',
    allowedChannels: ['gmail', 'portal'],
    customerKbCitations: 1,
    uncitedClaims: 0,
    linksAllowed: true,
    attachments: 0,
    placeholders: 0,
    length: 400,
    maxChars: 1200,
  },
  ticket: {
    priority: 'P3',
    openIncident: false,
    customerWantsHuman: false,
    autoStreak: 0,
    reopenedAfterAuto: false,
    placeholderOrg: false,
  },
  procedure: {
    autosendAllowed: true,
    stale: false,
    requiresHuman: false,
    escalationPending: false,
    replayPassed: true,
  },
  budget: { autoSentToday: 3, dailyCap: 20, aiBudgetExceeded: false },
};
const OPEN: SwitchState = { stageCapPinned: false, killSwitch: false };
const STAGE3: IntentStanding = { kind: 'found', stage: 3 };

/** One way to break one condition, and the reason it must give. */
const BREAKS: readonly {
  name: string;
  reason: GateReason;
  facts: (f: AutoSendFacts) => AutoSendFacts;
}[] = [
  {
    name: '1 flag off',
    reason: GATE_REASONS.autosendFlagOff,
    facts: (f) => ({ ...f, flagOn: false }),
  },
  { name: '6 no grade', reason: GATE_REASONS.gradeMissing, facts: (f) => ({ ...f, grade: null }) },
  {
    name: '6 hash differs',
    reason: GATE_REASONS.gradeHashMismatch,
    facts: (f) => ({ ...f, grade: { ...need(f.grade), hashMatches: false } }),
  },
  {
    name: '6 older than 10 minutes',
    reason: GATE_REASONS.gradeStale,
    facts: (f) => ({ ...f, grade: { ...need(f.grade), ageSeconds: 601 } }),
  },
  {
    name: '6 from the future',
    reason: GATE_REASONS.gradeStale,
    facts: (f) => ({ ...f, grade: { ...need(f.grade), ageSeconds: -60 } }),
  },
  {
    name: '6 not passed',
    reason: GATE_REASONS.gradeFailed,
    facts: (f) => ({ ...f, grade: { ...need(f.grade), passed: false } }),
  },
  {
    name: '6 violations',
    reason: GATE_REASONS.gradeViolations,
    facts: (f) => ({ ...f, grade: { ...need(f.grade), violationCount: 1 } }),
  },
  {
    name: '6 score below the minimum',
    reason: GATE_REASONS.gradeScoreLow,
    facts: (f) => ({ ...f, grade: { ...need(f.grade), score: 0.849 } }),
  },
  {
    name: '6 score is not a number',
    reason: GATE_REASONS.gradeScoreLow,
    facts: (f) => ({ ...f, grade: { ...need(f.grade), score: Number.NaN } }),
  },
  {
    name: '6 mock grade',
    reason: GATE_REASONS.gradeMock,
    facts: (f) => ({ ...f, grade: { ...need(f.grade), mock: true } }),
  },
  {
    name: '7 grader is the drafter',
    reason: GATE_REASONS.graderNotIndependent,
    facts: (f) => ({ ...f, grade: { ...need(f.grade), independent: false } }),
  },
  {
    name: '7 no ai_run row of the drafter or grader (C-11)',
    reason: GATE_REASONS.aiRunMissing,
    facts: (f) => ({ ...f, grade: { ...need(f.grade), runsKnown: false } }),
  },
  {
    name: '8 disclosure unknown',
    reason: GATE_REASONS.disclosureUnknown,
    facts: (f) => ({ ...f, disclosure: null }),
  },
  {
    name: '8 contact not verified',
    reason: GATE_REASONS.contactUnverified,
    facts: (f) => ({ ...f, disclosure: { contactVerified: false, senderAuthenticated: true } }),
  },
  {
    name: '8 sender not authenticated',
    reason: GATE_REASONS.senderUnauthenticated,
    facts: (f) => ({ ...f, disclosure: { contactVerified: true, senderAuthenticated: false } }),
  },
  {
    name: '9 no content facts',
    reason: GATE_REASONS.policyInvalid,
    facts: (f) => ({ ...f, content: null }),
  },
  {
    name: '9 policy does not parse',
    reason: GATE_REASONS.policyInvalid,
    facts: (f) => ({ ...f, content: { ...need(f.content), allowedChannels: null } }),
  },
  {
    name: '9 channel not on the list',
    reason: GATE_REASONS.channelNotAllowed,
    facts: (f) => ({ ...f, content: { ...need(f.content), channel: 'line' } }),
  },
  {
    name: '9 empty channel list',
    reason: GATE_REASONS.channelNotAllowed,
    facts: (f) => ({ ...f, content: { ...need(f.content), allowedChannels: [] } }),
  },
  {
    name: '9 no customer KB citation',
    reason: GATE_REASONS.noCustomerKbCitation,
    facts: (f) => ({ ...f, content: { ...need(f.content), customerKbCitations: 0 } }),
  },
  {
    name: '9 uncited sentence',
    reason: GATE_REASONS.uncitedClaims,
    facts: (f) => ({ ...f, content: { ...need(f.content), uncitedClaims: 1 } }),
  },
  {
    name: '9 foreign link',
    reason: GATE_REASONS.linkNotAllowed,
    facts: (f) => ({ ...f, content: { ...need(f.content), linksAllowed: false } }),
  },
  {
    name: '9 attachment',
    reason: GATE_REASONS.hasAttachment,
    facts: (f) => ({ ...f, content: { ...need(f.content), attachments: 1 } }),
  },
  {
    name: '9 placeholder',
    reason: GATE_REASONS.hasPlaceholder,
    facts: (f) => ({ ...f, content: { ...need(f.content), placeholders: 1 } }),
  },
  {
    name: '9 too long',
    reason: GATE_REASONS.tooLong,
    facts: (f) => ({ ...f, content: { ...need(f.content), length: 1201 } }),
  },
  {
    name: '9 empty',
    reason: GATE_REASONS.tooLong,
    facts: (f) => ({ ...f, content: { ...need(f.content), length: 0 } }),
  },
  {
    name: '10 no ticket facts',
    reason: GATE_REASONS.ticketFactsMissing,
    facts: (f) => ({ ...f, ticket: null }),
  },
  {
    name: '10 P1',
    reason: GATE_REASONS.priorityBlocked,
    facts: (f) => ({ ...f, ticket: { ...need(f.ticket), priority: 'P1' } }),
  },
  {
    name: '10 P2',
    reason: GATE_REASONS.priorityBlocked,
    facts: (f) => ({ ...f, ticket: { ...need(f.ticket), priority: 'P2' } }),
  },
  {
    name: '10 open incident',
    reason: GATE_REASONS.incidentOpen,
    facts: (f) => ({ ...f, ticket: { ...need(f.ticket), openIncident: true } }),
  },
  {
    name: '10 customer asked for a person',
    reason: GATE_REASONS.customerWantsHuman,
    facts: (f) => ({ ...f, ticket: { ...need(f.ticket), customerWantsHuman: true } }),
  },
  {
    name: '10 third automatic reply',
    reason: GATE_REASONS.autoStreakLimit,
    facts: (f) => ({ ...f, ticket: { ...need(f.ticket), autoStreak: AUTOSEND_MAX_STREAK } }),
  },
  {
    name: '10 reopened after an automatic reply',
    reason: GATE_REASONS.reopenedAfterAuto,
    facts: (f) => ({ ...f, ticket: { ...need(f.ticket), reopenedAfterAuto: true } }),
  },
  {
    name: '10 ticket in a placeholder organization (C-15)',
    reason: GATE_REASONS.placeholderOrg,
    facts: (f) => ({ ...f, ticket: { ...need(f.ticket), placeholderOrg: true } }),
  },
  {
    name: '11 no procedure facts',
    reason: GATE_REASONS.procedureUnknown,
    facts: (f) => ({ ...f, procedure: null }),
  },
  {
    name: '11 procedure says never',
    reason: GATE_REASONS.procedureNotAutosend,
    facts: (f) => ({ ...f, procedure: { ...need(f.procedure), autosendAllowed: false } }),
  },
  {
    name: '11 draft from an old version',
    reason: GATE_REASONS.procedureStale,
    facts: (f) => ({ ...f, procedure: { ...need(f.procedure), stale: true } }),
  },
  {
    name: '11 a require_human step matched (C-1)',
    reason: GATE_REASONS.procedureRequiresHuman,
    facts: (f) => ({ ...f, procedure: { ...need(f.procedure), requiresHuman: true } }),
  },
  {
    name: '11 an escalation card is pending (C-1)',
    reason: GATE_REASONS.escalationPending,
    facts: (f) => ({ ...f, procedure: { ...need(f.procedure), escalationPending: true } }),
  },
  {
    name: '11 no passing replay of the current set (C-4)',
    reason: GATE_REASONS.replayMissing,
    facts: (f) => ({ ...f, procedure: { ...need(f.procedure), replayPassed: false } }),
  },
  {
    name: '12 no budget facts',
    reason: GATE_REASONS.budgetUnknown,
    facts: (f) => ({ ...f, budget: null }),
  },
  {
    name: '12 daily cap reached',
    reason: GATE_REASONS.dailyCapReached,
    facts: (f) => ({ ...f, budget: { ...need(f.budget), autoSentToday: 20 } }),
  },
  {
    name: '12 cap of zero',
    reason: GATE_REASONS.dailyCapReached,
    facts: (f) => ({ ...f, budget: { ...need(f.budget), dailyCap: 0, autoSentToday: 0 } }),
  },
  {
    name: '12 AI budget spent',
    reason: GATE_REASONS.aiBudgetExceeded,
    facts: (f) => ({ ...f, budget: { ...need(f.budget), aiBudgetExceeded: true } }),
  },
];

const FACT_VARIANTS: readonly (AutoSendFacts | undefined)[] = [
  undefined,
  GOOD,
  ...BREAKS.map((entry) => entry.facts(GOOD)),
  { ...GOOD, flagOn: false },
];

function* everyInput(): Generator<DecisionInput> {
  for (const origin of SEND_ORIGINS) {
    for (const actorType of ACTORS) {
      for (const intent of INTENTS) {
        for (const switches of SWITCHES) {
          for (const autosend of FACT_VARIANTS) {
            yield {
              origin,
              actorType,
              actorId: actorType === 'user' ? USER_ID : null,
              templateKey: null,
              approvedBy: null,
              intent,
              switches,
              autosend,
            };
          }
        }
      }
    }
  }
}

const all = [...everyInput()];

describe('the automatic send (ADR-025 section 4)', () => {
  it('walks a large space (so the properties below are not vacuous)', () => {
    expect(all.length).toBeGreaterThan(30_000);
    expect(
      all.some(
        (input) => input.origin === 'ai_auto' && decide(input, SAFE_AUTO_ACK_TEMPLATES).allowed,
      ),
    ).toBe(true);
  });

  it('allows ai_auto when every one of the twelve conditions holds, and says so', () => {
    expect(
      decide(
        {
          origin: 'ai_auto',
          actorType: 'ai',
          actorId: null,
          templateKey: null,
          approvedBy: null,
          intent: STAGE3,
          switches: OPEN,
          autosend: GOOD,
        },
        SAFE_AUTO_ACK_TEMPLATES,
      ),
    ).toEqual({ allowed: true, reason: GATE_REASONS.aiAutoSendAllowed });
  });

  it('flag OFF => no ai_auto, for every origin, actor, stage, switch and set of facts', () => {
    for (const input of all) {
      if (input.autosend?.flagOn !== false && input.autosend !== undefined) continue;
      const decision = decide(input, SAFE_AUTO_ACK_TEMPLATES);
      if (input.origin === 'ai_auto') expect(decision.allowed, JSON.stringify(input)).toBe(false);
    }
  });

  it('stage below 3 => no ai_auto, even with the flag on and every fact good', () => {
    for (const input of all) {
      if (input.origin !== 'ai_auto') continue;
      const stage = input.intent.kind === 'found' ? input.intent.stage : -1;
      if (stage >= 3 && stage <= 4) continue;
      expect(decide(input, SAFE_AUTO_ACK_TEMPLATES).allowed, JSON.stringify(input)).toBe(false);
    }
  });

  it('stage 4 and 5 are not stage 3: a value past the known stages never acts', () => {
    for (const stage of [4, 5, 99]) {
      const input: DecisionInput = {
        origin: 'ai_auto',
        actorType: 'ai',
        actorId: null,
        templateKey: null,
        approvedBy: null,
        intent: { kind: 'found', stage },
        switches: OPEN,
        autosend: GOOD,
      };
      // 4 acts as 3 (the ceiling), 5 and 99 are not a stage at all.
      expect(decide(input, SAFE_AUTO_ACK_TEMPLATES).allowed, String(stage)).toBe(stage === 4);
    }
  });

  it('a missing fact => deny: every group of facts set to null denies, and no facts at all denies', () => {
    const groups = ['grade', 'disclosure', 'content', 'ticket', 'procedure', 'budget'] as const;
    for (const group of groups) {
      const decision = decideAutoSend({
        actorType: 'ai',
        intent: STAGE3,
        switches: OPEN,
        autosend: { ...GOOD, [group]: null },
      });
      expect(decision.allowed, group).toBe(false);
    }
    expect(
      decideAutoSend({ actorType: 'ai', intent: STAGE3, switches: OPEN, autosend: undefined }),
    ).toEqual({ allowed: false, reason: GATE_REASONS.aiAutoSendDisabledPhase1 });
  });

  it('refuses each condition with its own reason when nothing before it fails', () => {
    for (const entry of BREAKS) {
      const decision = decideAutoSend({
        actorType: 'ai',
        intent: STAGE3,
        switches: OPEN,
        autosend: entry.facts(GOOD),
      });
      expect(decision, entry.name).toEqual({ allowed: false, reason: entry.reason });
    }
  });

  it('checks the conditions in the order of the ADR: the flag, then the actor, the switches, the stage, the rest', () => {
    const decision = (input: Partial<Parameters<typeof decideAutoSend>[0]>) =>
      decideAutoSend({ actorType: 'ai', intent: STAGE3, switches: OPEN, autosend: GOOD, ...input })
        .reason;
    // Everything wrong at once: the flag is named first.
    const worst: AutoSendFacts = { ...GOOD, flagOn: false, grade: null, budget: null };
    expect(
      decision({
        actorType: 'user',
        switches: { stageCapPinned: true, killSwitch: true },
        intent: { kind: 'found', stage: 2 },
        autosend: worst,
      }),
    ).toBe(GATE_REASONS.autosendFlagOff);
    expect(
      decision({
        actorType: 'user',
        switches: { stageCapPinned: true, killSwitch: true },
        intent: { kind: 'found', stage: 2 },
      }),
    ).toBe(GATE_REASONS.actorOriginMismatch);
    expect(
      decision({
        switches: { stageCapPinned: true, killSwitch: true },
        intent: { kind: 'found', stage: 2 },
      }),
    ).toBe(GATE_REASONS.killSwitchOn);
    expect(
      decision({
        switches: { stageCapPinned: true, killSwitch: false },
        intent: { kind: 'found', stage: 2 },
      }),
    ).toBe(GATE_REASONS.stageCapOn);
    expect(
      decision({ intent: { kind: 'found', stage: 2 }, autosend: { ...GOOD, grade: null } }),
    ).toBe(GATE_REASONS.stageBelow3);
    expect(decision({ autosend: { ...GOOD, grade: null, budget: null } })).toBe(
      GATE_REASONS.gradeMissing,
    );
  });

  it('lists every condition that fails, in order, and nothing when none does', () => {
    expect(
      evaluateAutoSend({ actorType: 'ai', intent: STAGE3, switches: OPEN, autosend: GOOD }),
    ).toEqual([]);
    const failed = evaluateAutoSend({
      actorType: 'ai',
      intent: STAGE3,
      switches: OPEN,
      autosend: {
        ...GOOD,
        grade: { ...need(GOOD.grade), passed: false, violationCount: 2, independent: false },
        budget: { ...need(GOOD.budget), aiBudgetExceeded: true },
      },
    });
    expect(failed).toEqual([
      GATE_REASONS.gradeFailed,
      GATE_REASONS.gradeViolations,
      GATE_REASONS.graderNotIndependent,
      GATE_REASONS.aiBudgetExceeded,
    ]);
  });

  it('a shadow evaluation takes only the flag, the cap switch and the stage as given', () => {
    const base = {
      actorType: 'ai' as const,
      switches: { stageCapPinned: true, killSwitch: false },
    };
    // Stage 2, flag off, cap on: everything a promotion changes. All good otherwise: nothing in the way.
    expect(
      evaluateAutoSend(
        { ...base, intent: { kind: 'found', stage: 2 }, autosend: { ...GOOD, flagOn: false } },
        SHADOW_WAIVERS,
      ),
    ).toEqual([]);
    // The same without the waiver is three reasons.
    expect(
      evaluateAutoSend({
        ...base,
        intent: { kind: 'found', stage: 2 },
        autosend: { ...GOOD, flagOn: false },
      }),
    ).toEqual([GATE_REASONS.autosendFlagOff, GATE_REASONS.stageCapOn, GATE_REASONS.stageBelow3]);
    // The kill switch and everything else still count in a shadow.
    expect(
      evaluateAutoSend(
        {
          actorType: 'ai',
          switches: { stageCapPinned: false, killSwitch: true },
          intent: { kind: 'found', stage: 2 },
          autosend: { ...GOOD, grade: { ...need(GOOD.grade), mock: true } },
        },
        SHADOW_WAIVERS,
      ),
    ).toEqual([GATE_REASONS.killSwitchOn, GATE_REASONS.gradeMock]);
    // An unknown intent is not waived.
    expect(
      evaluateAutoSend(
        { actorType: 'ai', switches: OPEN, intent: { kind: 'missing' }, autosend: GOOD },
        SHADOW_WAIVERS,
      ),
    ).toEqual([GATE_REASONS.intentNotFound]);
  });

  it('only the AI actor with origin ai_auto can be allowed, and the kill switch always stops it', () => {
    for (const input of all) {
      const decision = decide(input, SAFE_AUTO_ACK_TEMPLATES);
      if (input.origin !== 'ai_auto') continue;
      if (decision.allowed) {
        expect(input.actorType).toBe('ai');
        expect(input.switches.killSwitch).toBe(false);
        expect(input.switches.stageCapPinned).toBe(false);
        expect(input.autosend?.flagOn).toBe(true);
        expect(input.intent.kind).toBe('found');
      }
      expect(ORIGIN_ACTOR.ai_auto).toBe('ai');
    }
  });

  it('keeps the ADR-011 guarantees for every other origin when facts are present', () => {
    // A set of facts on a non-ai_auto request changes nothing.
    for (const input of all) {
      if (input.origin === 'ai_auto') continue;
      const without = decide({ ...input, autosend: undefined }, SAFE_AUTO_ACK_TEMPLATES);
      expect(decide(input, SAFE_AUTO_ACK_TEMPLATES)).toEqual(without);
    }
  });

  it('the stage the system acts on never exceeds 2 without the flag, nor 3 with it', () => {
    for (const stage of [0, 1, 2, 3, 4, 5, 100]) {
      expect(effectiveStage(stage)).toBe(Math.min(stage, 2));
      expect(effectiveStage(stage, false)).toBe(Math.min(stage, 2));
      expect(effectiveStage(stage, true)).toBe(Math.min(stage, 3));
    }
  });
});

describe('T-306e C-1 and C-4: the procedure and replay facts', () => {
  const decideWith = (procedure: unknown) =>
    decideAutoSend({
      actorType: 'ai',
      intent: STAGE3,
      switches: OPEN,
      autosend: { ...GOOD, procedure } as AutoSendFacts,
    });
  const base = need(GOOD.procedure);

  it('a require_human step, a pending escalation or no replay => never ai_auto, across the whole input space', () => {
    for (const input of all) {
      if (input.origin !== 'ai_auto') continue;
      const procedure = input.autosend?.procedure;
      if (
        procedure !== null &&
        procedure !== undefined &&
        (procedure.requiresHuman || procedure.escalationPending || !procedure.replayPassed)
      ) {
        expect(decide(input, SAFE_AUTO_ACK_TEMPLATES).allowed, JSON.stringify(input)).toBe(false);
      }
    }
  });

  it('a fact that did not load (undefined, null, a truthy string) denies', () => {
    for (const bad of [undefined, null, 'no', 0]) {
      expect(
        decideWith({ ...base, requiresHuman: bad }).reason,
        `requiresHuman ${String(bad)}`,
      ).toBe(GATE_REASONS.procedureRequiresHuman);
      expect(
        decideWith({ ...base, escalationPending: bad }).reason,
        `escalationPending ${String(bad)}`,
      ).toBe(GATE_REASONS.escalationPending);
    }
    for (const bad of [undefined, null, 'yes', 1]) {
      expect(decideWith({ ...base, replayPassed: bad }).reason, `replayPassed ${String(bad)}`).toBe(
        GATE_REASONS.replayMissing,
      );
    }
  });

  it('is checked after condition 11 and before the budget', () => {
    const failed = evaluateAutoSend({
      actorType: 'ai',
      intent: STAGE3,
      switches: OPEN,
      autosend: {
        ...GOOD,
        procedure: {
          autosendAllowed: false,
          stale: true,
          requiresHuman: true,
          escalationPending: true,
          replayPassed: false,
        },
        budget: { ...need(GOOD.budget), aiBudgetExceeded: true },
      },
    });
    expect(failed).toEqual([
      GATE_REASONS.procedureNotAutosend,
      GATE_REASONS.procedureStale,
      GATE_REASONS.procedureRequiresHuman,
      GATE_REASONS.escalationPending,
      GATE_REASONS.replayMissing,
      GATE_REASONS.aiBudgetExceeded,
    ]);
  });
});
