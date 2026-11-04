import { schema, type Database } from '@watchtower/db';
import { AUDIT_ACTIONS, type AiSwitchKey } from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { readAiUsage } from '../ai/budget.js';
import type { AiCaps } from '../ai/budget.js';
import type {
  AiActionRequest,
  AutoSendEvaluation,
  CustomerSendRequest,
  GateAuditMeta,
  PolicyDecision,
  PolicyGate,
  SendOrigin,
} from '../policy.js';
import type { Actor } from '../types.js';
import { loadAutoSendFacts } from './autosend-facts.js';
import {
  SHADOW_WAIVERS,
  decide,
  decideAutoSend,
  effectiveStage,
  evaluateAutoSend,
  type IntentStanding,
  type SwitchState,
} from './decide.js';
import { SAFE_AUTO_ACK_TEMPLATES } from './safe-templates.js';

/** What the gate needs from the database: read the stage and the switches, write a denial. */
export type GateDatabase = Pick<Database['db'], 'select' | 'insert'>;

export interface PolicyGateOptions {
  /**
   * The handle the gate reads and audits through. Give it the pool, not a request transaction: a
   * denial usually ends the request in an error, and its audit row must survive the rollback.
   */
  readonly db: GateDatabase;
  /**
   * `AI_AUTOSEND_ENABLED` of this process (ADR-025 section 2), read once at boot from the environment. Absent
   * or false: no `ai_auto` decision can be allowed. The flag is never read from the database.
   */
  readonly autosendEnabled?: boolean | undefined;
  /** The daily AI caps (condition 12). Without them the budget fact is unknown and the decision is a denial. */
  readonly aiCaps?: AiCaps | undefined;
  /** Origins of the portal and the knowledge base of this instance (condition 9: no other link). */
  readonly linkOrigins?: readonly string[] | undefined;
}

/** Test seam only (not exported from the package): a gate with its own template list (review A-7). */
export interface TestPolicyGateOptions extends PolicyGateOptions {
  readonly safeTemplates: ReadonlySet<string>;
}

type SwitchRows = readonly { readonly key: string; readonly isOn: boolean }[];

/** A missing switch row reads as ON: if the table is damaged, the answer is the safe one. */
export function switchStateFrom(rows: SwitchRows): SwitchState {
  const on = (key: AiSwitchKey): boolean => rows.find((row) => row.key === key)?.isOn ?? true;
  return { stageCapPinned: on('ai_stage_cap_pinned'), killSwitch: on('ai_kill_switch') };
}

/** Reads the two global switches. */
export async function readSwitchState(db: Pick<GateDatabase, 'select'>): Promise<SwitchState> {
  return switchStateFrom(await db.select().from(schema.aiSwitch));
}

async function readIntentStanding(
  db: Pick<GateDatabase, 'select'>,
  intentId: string | null,
): Promise<IntentStanding> {
  if (intentId === null) return { kind: 'none' };
  const [row] = await db
    .select({ stage: schema.intent.autonomyStage })
    .from(schema.intent)
    .where(eq(schema.intent.id, intentId))
    .limit(1);
  return row === undefined ? { kind: 'missing' } : { kind: 'found', stage: row.stage };
}

/** The origin when the caller did not name one: derived from who acts. */
function originFor(actor: Actor, given: SendOrigin | undefined): SendOrigin | null {
  if (given !== undefined) return given;
  switch (actor.type) {
    case 'user':
      return 'human';
    case 'ai':
      return 'ai_auto';
    case 'system':
      return 'system_template';
    case 'anonymous':
      return null;
  }
}

/**
 * The real policy gate (T-112a, ADR-011). Reads the intent's stage and the switches fresh on every
 * call (no cache: a flipped switch takes effect on the next call), decides with `decide()`, and
 * writes an `autonomy.policy_denied` audit row for every denial. The domain asks it when a message
 * is scheduled; the outbound dispatcher asks again when it claims the delivery (ADR-010). Any error
 * (database down, bad id) rejects the promise, which `requireCustomerSend` turns into a refusal.
 *
 * The api builds it in `DomainModule`; the worker calls this same factory with its own database
 * handle, so both processes run the same rules.
 */
export function createPolicyGate(options: PolicyGateOptions): PolicyGate {
  return buildPolicyGate(options, SAFE_AUTO_ACK_TEMPLATES);
}

/** For tests only: the production list cannot be replaced through `createPolicyGate`. */
export function createPolicyGateForTest(options: TestPolicyGateOptions): PolicyGate {
  return buildPolicyGate(options, options.safeTemplates);
}

function buildPolicyGate(
  options: PolicyGateOptions,
  safeTemplates: ReadonlySet<string>,
): PolicyGate {
  const db = options.db;
  // Read once, here: the flag of this process. A gate built without it can never allow `ai_auto`.
  const flagOn = options.autosendEnabled === true;

  /** The facts of an automatic send, read fresh from the tables. */
  async function autoSendFacts(request: CustomerSendRequest) {
    const info = request.autoSend;
    if (info === undefined) return undefined;
    const caps = options.aiCaps;
    return loadAutoSendFacts(
      db,
      { ticketId: request.ticketId, ...info },
      {
        flagOn,
        linkOrigins: options.linkOrigins ?? [],
        aiBudgetExceeded: async () => {
          if (caps === undefined) return null;
          const usage = await readAiUsage(db, new Date());
          return usage.costUsd >= caps.dailyCostUsd || usage.tokens >= caps.dailyTokens;
        },
      },
    );
  }

  async function denyAudit(
    actor: Actor,
    auditMeta: GateAuditMeta | undefined,
    ticketId: string | null,
    decision: PolicyDecision,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await recordAuditInTx(
      db,
      { actor, auditMeta: auditMeta ?? { ip: null, requestId: null } },
      { audited: false },
      {
        action: AUDIT_ACTIONS.autonomyPolicyDenied,
        outcome: 'denied',
        targetType: ticketId === null ? null : 'ticket',
        targetId: ticketId,
        metadata: { reason: decision.reason, ...metadata },
      },
    );
  }

  return {
    async check(request: CustomerSendRequest): Promise<PolicyDecision> {
      const origin = originFor(request.actor, request.origin);
      const [intent, switches] = await Promise.all([
        readIntentStanding(db, request.intentId),
        readSwitchState(db),
      ]);
      // The stage and the facts come from the tables, not from the caller: the intent standing of an
      // `ai_auto` request is the one the facts loader read for the ticket itself.
      const loaded = origin === 'ai_auto' ? await autoSendFacts(request) : undefined;
      const decision: PolicyDecision =
        origin === null
          ? { allowed: false, reason: 'actor_origin_mismatch' }
          : decide(
              {
                origin,
                actorType: request.actor.type,
                actorId: request.actor.id,
                templateKey: request.templateKey ?? null,
                approvedBy: request.approvedBy ?? null,
                intent: loaded === undefined ? intent : loaded.intent,
                switches,
                autosend: loaded?.facts,
              },
              safeTemplates,
            );
      if (!decision.allowed) {
        await denyAudit(request.actor, request.auditMeta, request.ticketId, decision, {
          origin,
          channel: request.channel,
          intentId: request.intentId,
          templateKey: request.templateKey ?? null,
          stage: intent.kind === 'found' ? intent.stage : null,
          killSwitch: switches.killSwitch,
          stageCapPinned: switches.stageCapPinned,
          autosendFlag: flagOn,
        });
      }
      return decision;
    },

    async evaluateAutoSend(
      request: CustomerSendRequest,
      mode: 'live' | 'shadow',
    ): Promise<AutoSendEvaluation> {
      const switches = await readSwitchState(db);
      const loaded = await autoSendFacts(request);
      const input = {
        actorType: request.actor.type,
        intent: loaded?.intent ?? ({ kind: 'none' } as const),
        switches,
        autosend: loaded?.facts,
      };
      const failed = evaluateAutoSend(input, mode === 'shadow' ? SHADOW_WAIVERS : undefined);
      const decision: PolicyDecision =
        mode === 'live'
          ? decideAutoSend(input)
          : { allowed: failed.length === 0, reason: failed[0] ?? 'ai_auto_send_allowed' };
      const stage = input.intent.kind === 'found' ? input.intent.stage : -1;
      return {
        mode,
        decision,
        failed,
        effectiveStage: stage < 0 ? 0 : effectiveStage(stage, flagOn),
        intentId: loaded?.intentId ?? null,
        summary: {
          ...loaded?.summary,
          flagOn,
          stageCapPinned: switches.stageCapPinned,
          killSwitch: switches.killSwitch,
        },
      };
    },

    async checkAiAction(request: AiActionRequest): Promise<PolicyDecision> {
      const [intent, switches] = await Promise.all([
        readIntentStanding(db, request.intentId),
        readSwitchState(db),
      ]);
      const decision = decide(
        {
          origin: 'ai_internal',
          actorType: request.actor.type,
          actorId: request.actor.id,
          templateKey: null,
          approvedBy: null,
          intent,
          switches,
        },
        safeTemplates,
      );
      if (!decision.allowed) {
        await denyAudit(request.actor, request.auditMeta, request.ticketId, decision, {
          origin: 'ai_internal',
          action: request.action,
          intentId: request.intentId,
          stage: intent.kind === 'found' ? intent.stage : null,
          killSwitch: switches.killSwitch,
          stageCapPinned: switches.stageCapPinned,
        });
      }
      return decision;
    },
  };
}
