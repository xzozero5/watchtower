'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { Button, Kbd } from '@watchtower/ui';
import { X } from 'lucide-react';

import { useT } from '@/i18n/provider';
import { KEYMAP, type KeymapGroup } from '@/lib/keymap';

const GROUPS: readonly KeymapGroup[] = ['navigation', 'ticket', 'general', 'ai'];

export interface KeyboardMapProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Shown as Cmd instead of Ctrl on a Mac. */
  isMac: boolean;
}

/** The `?` dialog: every shortcut, grouped. Shortcuts not wired yet are listed and marked. */
export function KeyboardMap({ open, onOpenChange, isMac }: KeyboardMapProps) {
  const t = useT();
  const cap = (key: string) => (isMac && key === 'Ctrl' ? '⌘' : key);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content className="fixed top-[8vh] left-1/2 z-50 max-h-[84vh] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 overflow-y-auto rounded-lg border border-border-strong bg-surface p-pane text-foreground shadow-lg">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-lg font-semibold">{t('keymap.title')}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                {t('keymap.description')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label={t('keymap.close')}>
                <X aria-hidden className="size-4" />
              </Button>
            </Dialog.Close>
          </div>

          {GROUPS.map((group) => {
            const entries = KEYMAP.filter((entry) => entry.group === group);
            return (
              <section key={group} aria-labelledby={`keymap-${group}`} className="mt-4">
                <h2
                  id={`keymap-${group}`}
                  className="text-sm font-semibold tracking-wide text-muted-foreground uppercase"
                >
                  {t(`keymap.groups.${group}`)}
                </h2>
                <dl className="mt-2 divide-y divide-border">
                  {entries.map((entry) => (
                    <div key={entry.id} className="flex items-center justify-between gap-4 py-2">
                      <dt className="text-sm">
                        {t(entry.labelKey)}
                        {entry.available ? null : (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {t('keymap.comingSoon')}
                          </span>
                        )}
                      </dt>
                      <dd className="flex items-center gap-1">
                        {entry.keys.map((key, index) => (
                          <Kbd key={`${key}-${String(index)}`}>{cap(key)}</Kbd>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
