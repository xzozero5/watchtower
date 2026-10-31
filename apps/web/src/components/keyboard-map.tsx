'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { Alert, Button, Kbd } from '@watchtower/ui';
import { X } from 'lucide-react';
import { useId } from 'react';

import { useT } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { type KeymapEntry, type KeymapGroup, keymapFor } from '@/lib/keymap';
import { setSingleKeyShortcuts, usePreferences } from '@/lib/preferences';

const GROUPS: readonly KeymapGroup[] = ['navigation', 'panes', 'ticket', 'general', 'ai'];

export interface KeyboardMapProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Shown as Cmd instead of Ctrl on a Mac. */
  isMac: boolean;
}

/**
 * The `?` dialog: the shortcuts this user may use, grouped (a customer is not shown the keys for
 * notes, status or AI drafts). Shortcuts not wired yet are marked. It also holds the switch for
 * single-key shortcuts (WCAG 2.1.4); while they are off the keys they would press are marked "off".
 */
export function KeyboardMap({ open, onOpenChange, isMac }: KeyboardMapProps) {
  const t = useT();
  const { can } = useSession();
  const { singleKeyShortcuts } = usePreferences();
  const switchId = useId();
  const cap = (key: string) => (isMac && key === 'Ctrl' ? '⌘' : isMac && key === 'Alt' ? '⌥' : key);
  const entries = keymapFor(can);

  const keys = (keyList: readonly string[], sequence: boolean | undefined) =>
    keyList.map((key, index) => (
      <span key={`${key}-${String(index)}`} className="inline-flex items-center gap-1">
        {sequence && index > 0 ? (
          <span className="text-xs text-muted-foreground">{t('keymap.then')}</span>
        ) : null}
        <Kbd>{cap(key)}</Kbd>
      </span>
    ));

  const isOff = (entry: KeymapEntry) => entry.singleKey && !singleKeyShortcuts;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-scrim" />
        <Dialog.Content className="fixed top-[8vh] left-1/2 z-50 max-h-[84vh] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 overflow-y-auto rounded-xl border border-border bg-surface p-5 text-foreground shadow-overlay">
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

          <div className="mt-4 flex items-start gap-3">
            <input
              id={switchId}
              type="checkbox"
              checked={singleKeyShortcuts}
              onChange={(event) => {
                setSingleKeyShortcuts(event.target.checked);
              }}
              className="mt-1 size-4 accent-primary"
            />
            <div>
              <label htmlFor={switchId} className="text-sm font-medium">
                {t('prefs.singleKey.label')}
              </label>
              <p className="text-sm text-muted-foreground">{t('prefs.singleKey.hint')}</p>
            </div>
          </div>
          {singleKeyShortcuts ? null : (
            <Alert tone="info" title={t('keymap.singleKeyOffTitle')} className="mt-3">
              {t('keymap.singleKeyOffBody')}
            </Alert>
          )}

          {GROUPS.map((group) => {
            const inGroup = entries.filter((entry) => entry.group === group);
            if (inGroup.length === 0) return null;
            return (
              <section key={group} aria-labelledby={`keymap-${group}`} className="mt-4">
                <h2 id={`keymap-${group}`} className="text-xs font-medium text-muted-foreground">
                  {t(`keymap.groups.${group}`)}
                </h2>
                <dl className="mt-2 divide-y divide-border">
                  {inGroup.map((entry) => (
                    <div
                      key={entry.id}
                      data-keymap-id={entry.id}
                      className="flex items-center justify-between gap-4 py-2"
                    >
                      <dt className="text-sm">
                        {t(entry.labelKey)}
                        {entry.available ? null : (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {t('keymap.comingSoon')}
                          </span>
                        )}
                        {isOff(entry) ? (
                          <span className="ml-2 text-xs text-muted-foreground">
                            ({t('keymap.off')})
                          </span>
                        ) : null}
                      </dt>
                      <dd className="flex flex-wrap items-center justify-end gap-1">
                        {keys(entry.keys, entry.sequence)}
                        {(entry.alternatives ?? []).map((alternative) => (
                          <span
                            key={alternative.join('+')}
                            className="inline-flex items-center gap-1"
                          >
                            <span className="text-xs text-muted-foreground">{t('keymap.or')}</span>
                            {keys(alternative, false)}
                          </span>
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
