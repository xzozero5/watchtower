'use client';

import { Button, Tooltip } from '@watchtower/ui';
import { Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useI18n } from '@/i18n/provider';
import { useShortcut } from '@/lib/keyboard';
import { type PendingSend, usePendingSend } from '@/lib/outbound/pending-sends';
import { useSendUndo } from '@/lib/outbound/queries';
import { usePreferences } from '@/lib/preferences';

/** Whole seconds left, never below 0. */
const secondsLeft = (until: number, now: number) => Math.max(0, Math.ceil((until - now) / 1000));

/**
 * "Sending in N s · Undo" for a reply the server is still holding (the undo window, docs/06-UI-SPEC.md
 * section 17 Q1). Undo calls the server's cancel endpoint; `U` does the same. It reads the pending
 * send of this ticket from the store, so it is there whether the reply came from the composer or
 * from approving an AI draft, and it does not vanish when the draft card does. Nothing is sent by
 * this bar: the server sends when the window ends (N3: a person already decided).
 */
export function PendingSendBar({ ticketKey }: { ticketKey: string }) {
  const pending = usePendingSend(ticketKey);
  // Keyed by the delivery: a new send starts a new bar with a fresh clock.
  return pending ? <Bar key={pending.deliveryId} ticketKey={ticketKey} pending={pending} /> : null;
}

function Bar({ ticketKey, pending }: { ticketKey: string; pending: PendingSend }) {
  const { t } = useI18n();
  const { singleKeyShortcuts } = usePreferences();
  const { undo } = useSendUndo(ticketKey);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 250);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const run = () => {
    if (busy) return;
    setBusy(true);
    void undo(pending.deliveryId).finally(() => {
      setBusy(false);
    });
  };
  useShortcut('u', run, !busy);

  return (
    <div
      role="group"
      aria-label={t('outbound.bar')}
      data-testid="pending-send"
      className="mx-4 mt-2.5 flex shrink-0 items-center gap-3 rounded-lg bg-surface px-4 py-2.5 ring-1 ring-border/70 ring-inset"
    >
      <p role="status" className="text-sm text-muted-foreground">
        {t('outbound.sendingIn', { seconds: secondsLeft(pending.sendAt, now) })}
      </p>
      <Tooltip content={t('outbound.undo')} shortcut={singleKeyShortcuts ? ['U'] : []}>
        <Button
          className="rounded-full max-md:min-h-[44px]"
          aria-keyshortcuts={singleKeyShortcuts ? 'U' : undefined}
          disabled={busy}
          onClick={run}
        >
          <Undo2 aria-hidden className="size-4" />
          {t('outbound.undo')}
        </Button>
      </Tooltip>
    </div>
  );
}
