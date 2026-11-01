'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { LineQuota, Message } from '@watchtower/shared';
import { toast } from '@watchtower/ui';

import { useI18n } from '@/i18n/provider';
import { aiKey } from '@/lib/ai/queries';
import { useApi } from '@/lib/api/api-context';
import { isApiError } from '@/lib/api/errors';
import { useUserId } from '@/lib/auth/session';
import { ticketKeys, userScope } from '@/lib/tickets/queries';

import { addPendingSend, pendingSendOf, removePendingSend } from './pending-sends';

export const outboundKeys = (userId: string) => ({
  settings: [...userScope(userId), 'outbound', 'settings'] as const,
  lineQuota: [...userScope(userId), 'line', 'quota'] as const,
});

/** The LINE push allowance per account (R-2.10). Any failure means "unknown": nothing is shown. */
export function useLineQuota(enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: outboundKeys(userId).lineQuota,
    queryFn: ({ signal }) => api.lineQuota(signal),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

/** The quota row of the account a ticket's LINE conversation uses; with one account, that one. */
export function quotaFor(quota: LineQuota | undefined) {
  const accounts = quota?.accounts ?? [];
  // The ticket does not name its channel account yet, so the worst account decides the warning
  // rather than hiding a warning that applies `[ASSUMED]`.
  const rank = { exhausted: 3, warn: 2, ok: 1, unknown: 0 } as const;
  return [...accounts].sort((a, b) => rank[b.level] - rank[a.level])[0] ?? null;
}

/**
 * The undo window of a reply is held by the server, not the browser. `offer` takes the message a
 * reply returned; when its delivery can still be cancelled it remembers it (the Undo bar reads it)
 * and shows a toast with Undo. `undo` calls the server's cancel endpoint: if the window already
 * ended the server says 409 and the person is told it is too late.
 */
export function useSendUndo(ticketKey: string) {
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const { t } = useI18n();

  const refresh = () => {
    const keys = ticketKeys(userId);
    void queryClient.invalidateQueries({ queryKey: keys.timeline(ticketKey) });
    void queryClient.invalidateQueries({ queryKey: keys.detail(ticketKey) });
    // The draft this send approved is waiting for a person again after an undo.
    void queryClient.invalidateQueries({ queryKey: aiKey(userId, ticketKey) });
  };

  const undo = async (deliveryId: string): Promise<boolean> => {
    toast.dismiss(`send-${deliveryId}`);
    try {
      await api.cancelDelivery(ticketKey, deliveryId);
      removePendingSend(deliveryId);
      refresh();
      toast(t('outbound.undone'));
      return true;
    } catch (error) {
      removePendingSend(deliveryId);
      refresh();
      toast(
        isApiError(error) && error.status === 409
          ? t('outbound.tooLate')
          : t('outbound.undoFailed'),
      );
      return false;
    }
  };

  const offer = (message: Pick<Message, 'delivery'>, aiDraftId: string | null = null) => {
    const send = pendingSendOf(message, ticketKey, aiDraftId);
    if (!send) return null;
    addPendingSend(send);
    toast(
      t('outbound.sendingIn', {
        seconds: Math.max(1, Math.ceil((send.sendAt - Date.now()) / 1000)),
      }),
      {
        id: `send-${send.deliveryId}`,
        duration: Math.max(1000, send.sendAt - Date.now()),
        action: {
          label: t('outbound.undo'),
          onClick: () => {
            void undo(send.deliveryId);
          },
        },
      },
    );
    return send;
  };

  return { offer, undo };
}
