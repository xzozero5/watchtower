'use client';

import { TintChip } from '@watchtower/ui';
import { Languages } from 'lucide-react';

import { useI18n } from '@/i18n/provider';
import { detectProseLang } from '@/lib/ai/prose';

/**
 * A sentence the AI wrote, marked with the language it is in (`lang`), so a screen reader says it
 * right. When that is not the language of the page, a small `EN` / `TH` chip says so instead of
 * leaving English sitting unannounced in a Thai screen (docs/design/less-text-ai-assistant.md
 * section 4). The text is never translated here and never changed.
 */
export function AiProse({
  text,
  as: Tag = 'span',
  className,
}: {
  text: string;
  as?: 'span' | 'p';
  className?: string;
}) {
  const { t, locale } = useI18n();
  const lang = detectProseLang(text);
  return (
    <>
      <Tag lang={lang} className={className}>
        {text}
      </Tag>
      {lang !== locale ? (
        <TintChip
          tone="slate"
          icon={Languages}
          title={t('ai.draft.language', { language: lang.toUpperCase() })}
        >
          {lang.toUpperCase()}
        </TintChip>
      ) : null}
    </>
  );
}
