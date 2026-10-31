'use client';

import Image from 'next/image';
import type { ReactNode } from 'react';

import { PreferencesControls } from '@/components/preferences-controls';
import { useT } from '@/i18n/provider';

/**
 * Frame of the signed-out pages. This is the one place the brand ivory is a ground (a side panel
 * on a wide screen, a strip across the top on a phone); the form sits on the neutral canvas
 * beside it, with the display and language controls in its corner.
 */
export function LoginLayout({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <header className="flex items-center gap-3 bg-brand-surface px-6 py-4 text-brand-foreground lg:flex-col lg:justify-center lg:gap-6 lg:p-12 lg:text-center">
        {/* The name sits next to it as text, so the icon adds nothing for a screen reader. */}
        <Image
          src="/brand/watchtower-icon.png"
          alt=""
          width={160}
          height={160}
          className="size-9 rounded-lg lg:size-40 lg:rounded-[2rem]"
          priority
        />
        <p className="text-lg font-semibold lg:text-2xl">{t('app.name')}</p>
        <p className="hidden max-w-xs text-base leading-snug lg:block">
          {t('login.brand.tagline')}
        </p>
      </header>
      <div className="flex min-w-0 flex-col bg-background">
        <div className="flex justify-end px-6 pt-4 lg:px-10">
          <PreferencesControls />
        </div>
        <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-6 pt-6 pb-16">
          {children}
        </main>
      </div>
    </div>
  );
}
