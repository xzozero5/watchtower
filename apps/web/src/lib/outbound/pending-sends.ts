import type { Message } from '@watchtower/shared';
import { useSyncExternalStore } from 'react';

/**
 * Replies that wait out the undo window on the server (ADR-010, docs/06-UI-SPEC.md section 17 Q1).
 * The server owns the hold: `POST /v1/tickets/:id/replies` answers at once with a `delivery` whose
 * `sendAt` is the end of the window, and `POST .../deliveries/:id/cancel` takes the reply back.
 * This module only remembers which deliveries are still undoable, so the Undo bar and the toast
 * can outlive the card or the composer that sent them (moving to another ticket during the window
 * must not hide Undo). Nothing here sends or delays anything.
 */
export interface PendingSend {
  deliveryId: string;
  ticketKey: string;
  /** The end of the undo window, in ms since the epoch. */
  sendAt: number;
  /** The AI draft this send approved, if any: it returns to "waiting" when the send is undone. */
  aiDraftId: string | null;
}

/** The undoable delivery of a just-sent reply, or null (portal and other channels send at once). */
export function pendingSendOf(
  message: Pick<Message, 'delivery'>,
  ticketKey: string,
  aiDraftId: string | null = null,
  now: number = Date.now(),
): PendingSend | null {
  const delivery = message.delivery;
  if (!delivery?.cancellable || delivery.state !== 'scheduled') return null;
  const sendAt = Date.parse(delivery.sendAt);
  if (!Number.isFinite(sendAt) || sendAt <= now) return null;
  return { deliveryId: delivery.id, ticketKey, sendAt, aiDraftId };
}

type Listener = () => void;

let pending: readonly PendingSend[] = [];
const listeners = new Set<Listener>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const emit = () => {
  for (const listener of listeners) listener();
};

export function addPendingSend(send: PendingSend, now: number = Date.now()): void {
  pending = [...pending.filter((entry) => entry.deliveryId !== send.deliveryId), send];
  const old = timers.get(send.deliveryId);
  if (old) clearTimeout(old);
  // The window ends by itself: from then on the server is sending, and Undo would answer 409.
  timers.set(
    send.deliveryId,
    setTimeout(
      () => {
        removePendingSend(send.deliveryId);
      },
      Math.max(0, send.sendAt - now),
    ),
  );
  emit();
}

export function removePendingSend(deliveryId: string): void {
  const timer = timers.get(deliveryId);
  if (timer) clearTimeout(timer);
  timers.delete(deliveryId);
  const next = pending.filter((entry) => entry.deliveryId !== deliveryId);
  if (next.length === pending.length) return;
  pending = next;
  emit();
}

/** Test helper: forget everything. */
export function resetPendingSends(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  pending = [];
  emit();
}

const subscribe = (listener: Listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The newest undoable send of a ticket (null when there is none). */
export function usePendingSend(ticketKey: string): PendingSend | null {
  const all = useSyncExternalStore(
    subscribe,
    () => pending,
    () => pending,
  );
  return [...all].reverse().find((entry) => entry.ticketKey === ticketKey) ?? null;
}

/** True while a draft is waiting out its window (so a second Approve is refused locally). */
export function isDraftPending(aiDraftId: string): boolean {
  return pending.some((entry) => entry.aiDraftId === aiDraftId);
}
