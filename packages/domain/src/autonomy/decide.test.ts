import type { AuditActorType } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { SEND_ORIGINS } from '../policy.js';
import {
  GATE_REASONS,
  ORIGIN_ACTOR,
  decide,
  effectiveStage,
  type DecisionInput,
  type IntentStanding,
  type SwitchState,
} from './decide.js';
import { SAFE_AUTO_ACK_TEMPLATES } from './safe-templates.js';

const SAFE = 'auto_ack.received';
const UNSAFE = 'free_text_reply';
const ACTORS: readonly AuditActorType[] = ['user', 'system', 'ai', 'anonymous'];
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

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
const TEMPLATES: readonly (string | null)[] = [null, '', SAFE, UNSAFE];
const APPROVERS: readonly (string | null)[] = [null, '', USER_ID, OTHER_ID];

function* everyInput(): Generator<DecisionInput> {
  for (const origin of SEND_ORIGINS) {
    for (const actorType of ACTORS) {
      for (const intent of INTENTS) {
        for (const switches of SWITCHES) {
          for (const templateKey of TEMPLATES) {
            for (const approvedBy of APPROVERS) {
              yield {
                origin,
                actorType,
                actorId: actorType === 'user' ? USER_ID : null,
                templateKey,
                approvedBy,
                intent,
                switches,
              };
            }
          }
        }
      }
    }
  }
}

const gate = (input: Partial<DecisionInput> & Pick<DecisionInput, 'origin'>) =>
  decide(
    {
      actorType: ORIGIN_ACTOR[input.origin],
      actorId: ORIGIN_ACTOR[input.origin] === 'user' ? USER_ID : null,
      templateKey: null,
      approvedBy: null,
      intent: { kind: 'found', stage: 2 },
      switches: { stageCapPinned: false, killSwitch: false },
      ...input,
    },
    SAFE_AUTO_ACK_TEMPLATES,
  );

describe('the truth table (ADR-011), one row per rule', () => {
  it('lets a person send a reply whatever the intent says and with every switch', () => {
    for (const intent of INTENTS) {
      for (const switches of SWITCHES) {
        expect(gate({ origin: 'human', intent, switches })).toEqual({
          allowed: true,
          reason: GATE_REASONS.humanStaff,
        });
      }
    }
  });

  it('lets a person send an AI draft they approved, from stage 1', () => {
    const approved = { approvedBy: USER_ID };
    expect(
      gate({ origin: 'ai_approved', ...approved, intent: { kind: 'found', stage: 1 } }),
    ).toEqual({
      allowed: true,
      reason: GATE_REASONS.aiDraftHumanApproved,
    });
    expect(
      gate({ origin: 'ai_approved', ...approved, intent: { kind: 'found', stage: 2 } }),
    ).toMatchObject({
      allowed: true,
    });
    // The kill switch stops AI runs; a person sending text they read is not an AI run [ASSUMED].
    expect(
      gate({
        origin: 'ai_approved',
        ...approved,
        switches: { stageCapPinned: true, killSwitch: true },
      }),
    ).toMatchObject({ allowed: true });
  });

  it('refuses an approved draft at stage 0, with no intent, with a missing intent, or with no real approver', () => {
    const approved = { approvedBy: USER_ID };
    expect(
      gate({ origin: 'ai_approved', ...approved, intent: { kind: 'found', stage: 0 } }),
    ).toEqual({
      allowed: false,
      reason: GATE_REASONS.stageZeroNoCustomerDraft,
    });
    expect(gate({ origin: 'ai_approved', ...approved, intent: { kind: 'none' } }).reason).toBe(
      GATE_REASONS.intentUnknown,
    );
    expect(gate({ origin: 'ai_approved', ...approved, intent: { kind: 'missing' } }).reason).toBe(
      GATE_REASONS.intentNotFound,
    );
    expect(gate({ origin: 'ai_approved' }).reason).toBe(GATE_REASONS.approvalMissing);
    expect(gate({ origin: 'ai_approved', approvedBy: OTHER_ID }).reason).toBe(
      GATE_REASONS.approvalMissing,
    );
  });

  it('lets a safe template go as an automatic acknowledgment at every stage, even with the kill switch', () => {
    for (const intent of INTENTS) {
      for (const switches of SWITCHES) {
        expect(gate({ origin: 'system_template', templateKey: SAFE, intent, switches })).toEqual({
          allowed: true,
          reason: GATE_REASONS.safeTemplateAutoAck,
        });
      }
    }
  });

  it('refuses a template that is not on the list, or none', () => {
    expect(gate({ origin: 'system_template', templateKey: UNSAFE }).reason).toBe(
      GATE_REASONS.templateNotAllowlisted,
    );
    expect(gate({ origin: 'system_template', templateKey: null }).reason).toBe(
      GATE_REASONS.templateMissing,
    );
    expect(gate({ origin: 'system_template', templateKey: '' }).reason).toBe(
      GATE_REASONS.templateMissing,
    );
  });

  it('never lets the AI send on its own, at any stage, with any switch', () => {
    for (const intent of INTENTS) {
      for (const switches of SWITCHES) {
        expect(gate({ origin: 'ai_auto', intent, switches })).toEqual({
          allowed: false,
          reason: GATE_REASONS.aiAutoSendDisabledPhase1,
        });
      }
    }
  });

  it('lets the AI work internally at every stage, including on an unclassified ticket, unless the kill switch is on', () => {
    const workable = INTENTS.filter(
      (candidate) =>
        candidate.kind === 'none' ||
        (candidate.kind === 'found' &&
          Number.isInteger(candidate.stage) &&
          candidate.stage >= 0 &&
          candidate.stage <= 4),
    );
    for (const intent of workable) {
      expect(gate({ origin: 'ai_internal', intent })).toEqual({
        allowed: true,
        reason: GATE_REASONS.aiInternalAllowed,
      });
      expect(
        gate({
          origin: 'ai_internal',
          intent,
          switches: { stageCapPinned: true, killSwitch: false },
        }),
      ).toMatchObject({ allowed: true });
      expect(
        gate({
          origin: 'ai_internal',
          intent,
          switches: { stageCapPinned: false, killSwitch: true },
        }),
      ).toEqual({ allowed: false, reason: GATE_REASONS.killSwitchOn });
    }
    expect(gate({ origin: 'ai_internal', intent: { kind: 'missing' } }).reason).toBe(
      GATE_REASONS.intentNotFound,
    );
  });

  it('does not trust a stored stage that is not 0-4 on the AI paths', () => {
    for (const stage of [-1, 5, 1.5, Number.NaN]) {
      const intent = { kind: 'found' as const, stage };
      expect(gate({ origin: 'ai_internal', intent }).reason).toBe(GATE_REASONS.invalidStage);
      expect(gate({ origin: 'ai_approved', approvedBy: USER_ID, intent }).reason).toBe(
        GATE_REASONS.invalidStage,
      );
    }
  });

  it('refuses when who acts does not match what is sent', () => {
    for (const origin of SEND_ORIGINS) {
      for (const actorType of ACTORS.filter((type) => type !== ORIGIN_ACTOR[origin])) {
        expect(
          gate({
            origin,
            actorType,
            actorId: actorType === 'user' ? USER_ID : null,
            approvedBy: USER_ID,
            templateKey: SAFE,
          }),
        ).toEqual({ allowed: false, reason: GATE_REASONS.actorOriginMismatch });
      }
    }
  });

  it('acts on min(stage, 2): the cap never raises a stage 0 or 1', () => {
    expect(effectiveStage(0)).toBe(0);
    expect(effectiveStage(1)).toBe(1);
    expect(effectiveStage(2)).toBe(2);
    expect(effectiveStage(4)).toBe(2);
  });
});

describe('the safe template list', () => {
  it('cannot be changed at run time (review A-7)', () => {
    const set = SAFE_AUTO_ACK_TEMPLATES as Set<string>;
    expect(() => set.add('anything_else')).toThrow(TypeError);
    expect(() => set.delete(SAFE)).toThrow(TypeError);
    expect(() => {
      set.clear();
    }).toThrow(TypeError);
    expect(Object.isFrozen(set)).toBe(true);
    expect([...set].toSorted()).toEqual(['auto_ack.received', 'auto_ack.received_with_sla']);
  });
});

describe('Phase 1 invariants over the whole input space', () => {
  const all = [...everyInput()];

  it('covers a large, non-trivial space', () => {
    expect(all.length).toBeGreaterThan(10_000);
  });

  it('gives every decision a reason code', () => {
    for (const input of all) {
      const decision = decide(input, SAFE_AUTO_ACK_TEMPLATES);
      expect(decision.reason).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('never lets AI-written content reach a customer unless a person approved and sent it', () => {
    // "Customer-facing" = any origin except ai_internal. An allowed customer-facing decision must
    // be (a) a person acting (human / ai_approved with that same person as approver), or (b) a
    // system sender with a template on the safe list. The AI actor is in neither.
    for (const input of all) {
      const decision = decide(input, SAFE_AUTO_ACK_TEMPLATES);
      if (!decision.allowed || input.origin === 'ai_internal') continue;
      expect(input.actorType, JSON.stringify(input)).not.toBe('ai');
      expect(input.actorType, JSON.stringify(input)).not.toBe('anonymous');
      expect(input.origin, JSON.stringify(input)).not.toBe('ai_auto');
      if (input.origin === 'ai_approved') {
        expect(input.actorType).toBe('user');
        expect(input.approvedBy).toBe(input.actorId);
        expect(input.approvedBy).not.toBeNull();
        expect(input.intent.kind).toBe('found');
      }
      if (input.origin === 'system_template') {
        expect(input.actorType).toBe('system');
        expect(SAFE_AUTO_ACK_TEMPLATES.has(input.templateKey ?? '')).toBe(true);
      }
    }
  });

  it('never allows ai_auto, and never allows anything for the AI actor except internal work', () => {
    for (const input of all) {
      const decision = decide(input, SAFE_AUTO_ACK_TEMPLATES);
      if (input.origin === 'ai_auto') expect(decision.allowed).toBe(false);
      if (input.actorType === 'ai' && decision.allowed) expect(input.origin).toBe('ai_internal');
    }
  });

  it('does not let any input past the kill switch for AI work', () => {
    for (const input of all) {
      if (input.actorType !== 'ai' || !input.switches.killSwitch) continue;
      expect(decide(input, SAFE_AUTO_ACK_TEMPLATES).allowed).toBe(false);
    }
  });

  it('allows nothing for an anonymous actor', () => {
    for (const input of all.filter((candidate) => candidate.actorType === 'anonymous')) {
      expect(decide(input, SAFE_AUTO_ACK_TEMPLATES).allowed).toBe(false);
    }
  });

  it('allows a template only if it is on the list given, whatever its spelling', () => {
    const keys = [
      SAFE,
      SAFE.toUpperCase(),
      ` ${SAFE}`,
      `${SAFE} `,
      'auto_ack.*',
      '__proto__',
      'constructor',
      'toString',
    ];
    for (const key of keys) {
      const allowed = decide(
        {
          origin: 'system_template',
          actorType: 'system',
          actorId: null,
          templateKey: key,
          approvedBy: null,
          intent: { kind: 'none' },
          switches: { stageCapPinned: false, killSwitch: false },
        },
        SAFE_AUTO_ACK_TEMPLATES,
      ).allowed;
      expect(allowed, key).toBe(key === SAFE);
    }
    // An empty list allows nothing.
    expect(
      decide(
        {
          origin: 'system_template',
          actorType: 'system',
          actorId: null,
          templateKey: SAFE,
          approvedBy: null,
          intent: { kind: 'none' },
          switches: { stageCapPinned: false, killSwitch: false },
        },
        new Set(),
      ).allowed,
    ).toBe(false);
  });
});
