'use client';

import { Select } from '@watchtower/ui';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useId } from 'react';

import { isLocale, LOCALE_NAMES, LOCALES } from '@/i18n';
import { useI18n } from '@/i18n/provider';
import { saveLocale } from '@/lib/locale-cookie';

/**
 * The public portal's page frame (UI spec section 10): brand and a TH/EN switch, one centred
 * column, nothing else. No app navigation, no sign-in gate. The header is the portal's brand
 * moment (docs/design/ui-refresh-2026-11.md rule 3).
 */
export function PortalFrame({ children }: { children: ReactNode }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const languageId = useId();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3 px-pane py-3">
          <Link href="/portal" className="flex items-center gap-2 rounded-md">
            <Image
              src="/brand/watchtower-icon.png"
              alt=""
              width={32}
              height={32}
              className="size-8 rounded-md"
              priority
            />
            <span className="text-base font-semibold">{t('portal.frame.brand')}</span>
          </Link>
          <div className="flex items-center gap-1.5">
            <label htmlFor={languageId} className="text-sm text-muted-foreground">
              {t('portal.frame.language')}
            </label>
            <Select
              id={languageId}
              value={locale}
              onChange={(event) => {
                const next = event.target.value;
                if (!isLocale(next)) return;
                saveLocale(next);
                router.refresh();
              }}
            >
              {LOCALES.map((value) => (
                <option key={value} value={value} lang={value}>
                  {LOCALE_NAMES[value]}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </header>
      <main
        aria-label={t('portal.frame.main')}
        className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-stack px-pane py-6"
      >
        {children}
      </main>
    </div>
  );
}
