import {
  CircleHelp,
  FileText,
  KeyRound,
  Scale,
  Settings,
  Tag,
  Timer,
  TriangleAlert,
  Webhook,
} from 'lucide-react';

import type { TintId } from '../tokens/colors.js';
import { TintChip, type ChipIcon, type TintChipProps } from './tint-chip.js';

/**
 * Eight friendly hues for intents. Red is left out (P1 and breach only) and so is slate (priority
 * P4), so an intent is never mistaken for an alert.
 */
export const INTENT_TINTS = [
  'blue',
  'teal',
  'violet',
  'amber',
  'green',
  'indigo',
  'pink',
  'sky',
] as const satisfies readonly TintId[];

/** A stable hue for an intent key: the same intent is the same colour on every screen. */
export function intentTint(key: string): (typeof INTENT_TINTS)[number] {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return INTENT_TINTS[hash % INTENT_TINTS.length] ?? 'blue';
}

/** Intent families, matched on the intent key. The first match wins; anything else gets a tag. */
const FAMILIES: readonly (readonly [RegExp, ChipIcon])[] = [
  [/dispute|refund|complaint/u, Scale],
  [/webhook|callback/u, Webhook],
  [/timeout|latency|slow/u, Timer],
  [/incident|outage|error|failure|alert/u, TriangleAlert],
  [/login|access|auth|password|sso|account/u, KeyRound],
  [/billing|invoice|report|export|statement/u, FileText],
  [/config|setup|settings|workspace/u, Settings],
  [/question|howto|how_to|faq|inquiry|info/u, CircleHelp],
];

/** The icon for an intent key (`account_access` is a key, `upstream_timeout` a timer). */
export function intentIcon(key: string): ChipIcon {
  const lower = key.toLowerCase();
  for (const [pattern, icon] of FAMILIES) if (pattern.test(lower)) return icon;
  return Tag;
}

export interface IntentChipProps extends Omit<TintChipProps, 'tone' | 'icon' | 'children'> {
  /** The stable intent key, for example `account_access`. It picks the hue and the icon. */
  intentKey: string;
  /** The translated name shown on the chip. */
  name: string;
}

/** An intent as a tinted chip with an icon of its family and its name. */
export function IntentChip({ intentKey, name, className, ...props }: IntentChipProps) {
  return (
    <TintChip
      tone={intentTint(intentKey)}
      icon={intentIcon(intentKey)}
      data-intent={intentKey}
      className={className}
      {...props}
    >
      {name}
    </TintChip>
  );
}
