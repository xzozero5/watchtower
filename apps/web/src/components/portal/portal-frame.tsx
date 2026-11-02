'use client';

import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { DisplayControls } from '@/components/display-controls';
import type { MessageKey } from '@/i18n';
import { useI18n } from '@/i18n/provider';

/**
 * The public portal's page frame (UI spec section 10): brand, the language flags and the theme switch,
 * one centred
 * column, nothing else. No app navigation, no sign-in gate. The header is the portal's brand
 * moment (docs/design/ui-refresh-2026-11.md rule 3).
 */
export function PortalFrame({
  children,
  homeHref = '/portal',
  brandKey = 'portal.frame.brand',
  mainKey = 'portal.frame.main',
  width = 'max-w-2xl',
}: {
  children: ReactNode;
  /** Where the brand links to: the public page the frame belongs to. */
  homeHref?: string;
  brandKey?: MessageKey;
  mainKey?: MessageKey;
  width?: 'max-w-2xl' | 'max-w-3xl';
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border/60 bg-background">
        <div
          className={`mx-auto flex w-full ${width} items-center justify-between gap-3 px-pane py-3`}
        >
          <Link href={homeHref} className="flex items-center gap-2 rounded-md">
            <Image
              src="/brand/watchtower-icon.png"
              alt=""
              width={32}
              height={32}
              className="size-8 rounded-xl"
              priority
            />
            <span className="text-base font-semibold">{t(brandKey)}</span>
          </Link>
          <DisplayControls />
        </div>
      </header>
      <main
        aria-label={t(mainKey)}
        className={`mx-auto flex w-full ${width} flex-1 flex-col gap-stack px-pane py-6`}
      >
        {children}
      </main>
    </div>
  );
}
