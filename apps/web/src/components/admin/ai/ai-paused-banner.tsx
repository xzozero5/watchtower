'use client';

import { Alert } from '@watchtower/ui';

import { AppLink } from '@/components/app-link';
import { useI18n } from '@/i18n/provider';
import { useAutonomy } from '@/lib/admin/queries';
import { useSession } from '@/lib/auth/session';
import { formatMessageTime } from '@/lib/format';

/**
 * While the kill switch is on, every staff member sees this at the top of the main area. It is not
 * dismissible and not red: stopping the AI is a safe state, not an incident (docs/06-UI-SPEC.md
 * sections 6.5 and 18.4). Agents cannot read the user list, so unless the api sends the name of
 * who stopped it they see the time only. The stage limit has no banner (H5).
 */
export function AiPausedBanner() {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const autonomy = useAutonomy(can('ticket.read'));
  const kill = autonomy.data?.switches.find((item) => item.key === 'ai_kill_switch');
  if (!kill?.on) return null;

  const time = formatMessageTime(kill.changedAt, locale);
  const title = kill.changedByName
    ? t('ai.paused', { name: kill.changedByName, time })
    : t('ai.pausedNoName', { time });

  return (
    <div className="border-b border-border bg-background p-2" data-testid="ai-paused-banner">
      <Alert tone="info" title={title}>
        {can('ai.autonomy.set') ? (
          <AppLink
            href="/admin/ai"
            className="rounded-sm text-link underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t('ai.pausedLink')}
          </AppLink>
        ) : null}
      </Alert>
    </div>
  );
}
