'use client';

import { EmptyState, Kbd } from '@watchtower/ui';
import { Sparkles } from 'lucide-react';

import { useT } from '@/i18n/provider';

/**
 * Placeholder for the AI assistant (report, evidence, draft reply with approve / edit / reject).
 * The real panel arrives in Phase 1 (T-109), after the AI layer exists. Saying so plainly is
 * better than an empty box that looks broken.
 */
export function AiSidebar() {
  const t = useT();
  return (
    <EmptyState
      icon={<Sparkles className="size-8" />}
      title={t('ai.title')}
      description={t('ai.body')}
      action={
        <ul className="mt-2 flex max-w-prose flex-col gap-1 text-left text-sm text-muted-foreground">
          <li>{t('ai.coming.report')}</li>
          <li>{t('ai.coming.evidence')}</li>
          <li>
            {t('ai.coming.draft')} <Kbd>A</Kbd> <Kbd>E</Kbd> <Kbd>R</Kbd>
          </li>
        </ul>
      }
    />
  );
}
