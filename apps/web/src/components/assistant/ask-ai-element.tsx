'use client';

import {
  INSIGHT_ELEMENTS,
  isInsightPeriodAllowed,
  type AssistantEntity,
  type InsightElementKey,
  type Permission,
  assistantElementSchema,
} from '@watchtower/shared';
import type { MessageKey } from '@/i18n';
import { useI18n } from '@/i18n/provider';
import { isAssistantWorkspace } from '@/lib/assistant/access';
import { useAssistantStarters } from '@/lib/assistant/use-assistant-chat';
import { useSession } from '@/lib/auth/session';
import { AskAiButton } from './ask-ai-button';

export interface AskAiElementProps {
  element: InsightElementKey;
  scope?: string;
  period?: string;
  label?: string;
  entity?: AssistantEntity;
  /** A visible view that the assistant contract cannot represent must not become a broader query. */
  disabledReason?: string;
  presentation?: 'icon' | 'follow-up';
}

/** Uses the route's registry rule, including F and reused AI; never starts narration or sends a question. */
export function AskAiElement({
  element: key,
  scope,
  period,
  label,
  entity,
  disabledReason,
  presentation,
}: AskAiElementProps) {
  const { can, session } = useSession();
  const { t, locale } = useI18n();
  const entry = INSIGHT_ELEMENTS[key];
  const allowed =
    entry.rule &&
    ('all' in entry.rule
      ? entry.rule.all.every((permission: Permission) => can(permission))
      : entry.rule.anyOf.some((permission: Permission) => can(permission)));
  // All controls share this user/locale query. The state endpoint never calls a model.
  const availability = useAssistantStarters({
    enabled:
      entry.askAi && Boolean(allowed) && isAssistantWorkspace(session) && can('assistant.use'),
    locale,
    page: undefined,
    ticket: null,
  });
  if (!entry.askAi || entry.mode === 'X') return null;
  const state = availability.data?.state;
  const unavailableReason = availability.isError
    ? t('assistant.state.unavailable')
    : state && state !== 'ok'
      ? t(`assistant.state.${state}`)
      : undefined;
  const resolvedScope =
    scope ?? (entry.scope === 'instance' || entry.scope === 'user' ? entry.scope : '');
  const target = { key, scope: resolvedScope, ...(period ? { period } : {}) };
  const scopeMatches =
    entry.scope === 'instance' || entry.scope === 'user'
      ? resolvedScope === entry.scope
      : resolvedScope.startsWith(`${entry.scope}:`);
  // The current assistant contract accepts days only. Do not silently replace an ISO week with d7.
  const needsWeek = entry.periods.some((spec) => spec.kind === 'isoWeek');
  const invalidPeriod = period !== undefined && !isInsightPeriodAllowed(entry.periods, period);
  const reason =
    !can('assistant.use') || !allowed
      ? t('assistant.askAbout.noPermission')
      : !scopeMatches || !assistantElementSchema.safeParse(target).success
        ? t('assistant.askAbout.noScope')
        : needsWeek || invalidPeriod
          ? t('assistant.askAbout.unsupportedPeriod')
          : (disabledReason ?? unavailableReason);
  return (
    <AskAiButton
      presentation={presentation}
      {...(entity ? { entity } : {})}
      element={target}
      label={label ?? t(`assistant.elements.${key}` as MessageKey)}
      {...(reason ? { disabledReason: reason } : {})}
    />
  );
}
