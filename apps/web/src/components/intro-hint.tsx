'use client';

import { HelpHint } from '@watchtower/ui';
import type { ReactNode } from 'react';

import { useT } from '@/i18n/provider';

/**
 * The sentence that used to sit under a section heading, behind a `?` button
 * (docs/design/less-text-ai-assistant.md 1.1). `topic` is the section's own name, so the button is
 * announced as "More about Services". Use it for help only: a warning stays on the page.
 */
export function IntroHint({ topic, children }: { topic: string; children: ReactNode }) {
  const t = useT();
  return (
    <div className="flex">
      <HelpHint label={t('admin.moreInfo', { topic })}>{children}</HelpHint>
    </div>
  );
}
