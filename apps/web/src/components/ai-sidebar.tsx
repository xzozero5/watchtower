'use client';

import { Kbd } from '@watchtower/ui';
import { Bot } from 'lucide-react';

import { useT } from '@/i18n/provider';

/**
 * Placeholder for the AI assistant (report, evidence, draft reply with approve / edit / reject).
 * The real panel arrives in Phase 1 (T-109), after the AI layer exists. Saying so plainly is
 * better than an empty box that looks broken: a short explanation, no illustration.
 */
export function AiSidebar() {
  const t = useT();
  return (
    <div className="flex flex-col gap-3 p-4 text-sm">
      <p className="flex items-start gap-2 font-medium text-foreground">
        <Bot aria-hidden className="mt-0.5 size-4 shrink-0 text-ai-accent" />
        {t('ai.title')}
      </p>
      <p className="text-muted-foreground">{t('ai.body')}</p>
      <ul className="flex flex-col gap-1.5 text-muted-foreground">
        <li className="flex gap-2">
          <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-ai-accent" />
          {t('ai.coming.report')}
        </li>
        <li className="flex gap-2">
          <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-ai-accent" />
          {t('ai.coming.evidence')}
        </li>
        <li className="flex gap-2">
          <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-ai-accent" />
          <span>
            {t('ai.coming.draft')} <Kbd>A</Kbd> <Kbd>E</Kbd> <Kbd>R</Kbd>
          </span>
        </li>
      </ul>
    </div>
  );
}
