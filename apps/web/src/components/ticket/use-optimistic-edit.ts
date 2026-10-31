'use client';

import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@watchtower/ui';
import { useState } from 'react';

import { useI18n } from '@/i18n/provider';
import { useUserId } from '@/lib/auth/session';
import type { TicketItem } from '@/lib/tickets/model';
import { storeTicket } from '@/lib/tickets/queries';

/**
 * Hook behind every inline edit: show the new value at once (optimistic), send it, and put the old
 * value back if the api refuses. After a success a toast offers Undo, which sends the old value
 * the same way (without another Undo toast).
 */
export function useOptimisticEdit(ticket: TicketItem) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const userId = useUserId();
  const [saved, setSaved] = useState(false);

  /** Replaces the cached ticket (detail and queue row) without waiting for the api. */
  const show = (next: TicketItem) => {
    storeTicket(queryClient, userId, next);
  };

  const run = ({
    optimistic,
    send,
    message,
    undo,
  }: {
    /** The ticket as it will look after the change. */
    optimistic: TicketItem;
    send: (callbacks: { onSuccess: () => void; onError: () => void }) => void;
    message: string;
    /** Sends the opposite change; absent when there is nothing sensible to go back to. */
    undo?: () => void;
  }) => {
    const before = ticket;
    setSaved(false);
    show(optimistic);
    send({
      onSuccess: () => {
        setSaved(true);
        toast(message, undo ? { action: { label: t('details.undo'), onClick: undo } } : undefined);
      },
      onError: () => {
        show(before);
      },
    });
  };

  return {
    run,
    saved,
    clearSaved: () => {
      setSaved(false);
    },
  };
}
