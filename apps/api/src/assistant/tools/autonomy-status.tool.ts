import { aiSwitchKeySchema } from '@watchtower/shared';
import { z } from 'zod';

import {
  MAX_LIST,
  cutAtWord,
  holds,
  plain,
  toolFact,
  type ModuleToolContext,
  type ToolRegistrar,
} from './fact-kit.js';

/**
 * `autonomy_status` (T-405, supersedes ADR-023 section 1 by ADR-029 section 11): the autonomy stage of each intent,
 * whether its latest gate report passed, and whether the AI switches are on, as `GET /v1/autonomy` serves them
 * (`AutonomyService.read`). Read only: no tool changes a stage, a pin or a switch (N3). Output is an allow-list: no
 * reason text of a switch, no person who flipped it, no auto-send rules and no gate metrics.
 *
 * The gate result is read from the promotion door (`GET /v1/intents/:id/autonomy/promotion`, `intent.manage`): only a
 * person who holds that permission gets it; for everyone else `gate` is `hidden`. `pass` is a green report, `fail` a
 * red one, `not_enough_data` a report that could not decide, `no_report` none yet, `not_applicable` an intent below
 * stage 2 (there is nothing to promote).
 */
export const GATE_STATES = [
  'pass',
  'fail',
  'not_enough_data',
  'no_report',
  'not_applicable',
  'hidden',
] as const;

export const autonomyStatusInput = z.strictObject({
  /** One intent by key; absent: the intents with the highest stage first. */
  intent: z.string().trim().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(MAX_LIST).default(MAX_LIST),
});

export const autonomyStatusOutput = z.strictObject({
  switches: z.array(z.strictObject({ key: aiSwitchKeySchema, on: z.boolean() })).max(4),
  autosendFlag: z.boolean(),
  intents: z
    .array(
      z.strictObject({
        id: z.uuid(),
        key: z.string().max(100),
        name: z.string().max(300),
        isActive: z.boolean(),
        stage: z.number().int().min(0).max(3),
        effectiveStage: z.number().int().min(0).max(3),
        pinned: z.boolean(),
        gate: z.enum(GATE_STATES),
      }),
    )
    .max(MAX_LIST),
});
export type AutonomyStatusOutput = z.infer<typeof autonomyStatusOutput>;

export function autonomyStatusFacts(output: AutonomyStatusOutput) {
  const state = (key: string): string => {
    const found = output.switches.find((entry) => entry.key === key);
    return found === undefined ? 'unknown' : found.on ? 'ON' : 'OFF';
  };
  return [
    toolFact({
      kind: 'config',
      id: 'ai_switches',
      label: 'AI switches',
      text: plain(
        `AI kill switch is ${state('ai_kill_switch')}. Stage cap pinned is ${state('ai_stage_cap_pinned')}. Auto-send is ${output.autosendFlag ? 'enabled' : 'disabled'} on this instance (while disabled no intent acts above stage 2).`,
      ),
      trust: 'system',
      href: '/admin/ai',
    }),
    ...output.intents.map((entry) =>
      toolFact({
        kind: 'intent',
        id: entry.id,
        label: entry.name,
        text: plain(
          `Intent "${entry.name}" (${entry.key})${entry.isActive ? '' : ' [inactive]'}: stage ${String(entry.stage)}, acts at stage ${String(entry.effectiveStage)}${entry.pinned ? ', stage pinned by the head' : ''}. Promotion gate: ${entry.gate.replaceAll('_', ' ')}.`,
        ),
        trust: 'system',
        href: `/admin/intents/${entry.id}`,
      }),
    ),
  ];
}

export function autonomyStatusTool(ctx: ModuleToolContext): ToolRegistrar {
  return (add) => {
    add(
      'autonomy_status',
      {
        description:
          'The autonomy stage of each intent, whether its latest promotion gate passed, and whether the AI kill switch is on. Read only.',
        input: autonomyStatusInput,
        output: autonomyStatusOutput,
        async execute(input) {
          const state = await ctx.services.autonomy.read();
          const chosen = state.intents
            .filter((entry) => input.intent === undefined || entry.key === input.intent)
            .toSorted((a, b) => b.stage - a.stage || a.name.localeCompare(b.name))
            .slice(0, input.limit);
          const mayReadGate = holds(ctx.principal, 'intent.manage');
          const intents: AutonomyStatusOutput['intents'] = [];
          for (const entry of chosen) {
            let gate: AutonomyStatusOutput['intents'][number]['gate'] = 'hidden';
            if (mayReadGate) {
              if (entry.stage < 2) gate = 'not_applicable';
              else {
                const door = await ctx.services.autonomy.promotionState(entry.id);
                const status = door.latestReport?.status;
                gate =
                  status === undefined
                    ? 'no_report'
                    : status === 'green'
                      ? 'pass'
                      : status === 'red'
                        ? 'fail'
                        : 'not_enough_data';
              }
            }
            intents.push({
              id: entry.id,
              key: cutAtWord(entry.key, 100),
              name: cutAtWord(entry.name, 300),
              isActive: entry.isActive,
              stage: entry.stage,
              effectiveStage: entry.effectiveStage,
              pinned: entry.pinned,
              gate,
            });
          }
          return {
            switches: state.switches.map((entry) => ({ key: entry.key, on: entry.on })),
            autosendFlag: state.autosendFlag,
            intents,
          };
        },
      },
      '{"intent"?: "intent key", "limit"?: 20}',
      (output) => autonomyStatusFacts(output),
    );
  };
}
