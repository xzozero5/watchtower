'use client';

import Image from 'next/image';
import type { ReactNode } from 'react';

import { PreferencesControls } from '@/components/preferences-controls';
import { useT } from '@/i18n/provider';

/** Frame of the signed-out pages: brand, display/language controls and one centred column. */
export function LoginLayout({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border bg-surface px-pane py-2">
        <div className="flex items-center gap-2">
          <Image
            src="/brand/watchtower-icon.png"
            alt=""
            width={32}
            height={32}
            className="size-8 rounded-md"
            priority
          />
          <p className="text-base font-semibold">{t('app.name')}</p>
        </div>
        <PreferencesControls />
      </header>
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-stack p-pane">
        {children}
      </main>
    </div>
  );
}
