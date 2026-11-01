'use client';

import { toast } from '@watchtower/ui';
import type { TicketStatus } from '@watchtower/shared';

import { useI18n } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import type { TicketItem } from '@/lib/tickets/model';
import { useTicketMutations, useWorkflow } from '@/lib/tickets/queries';
import { statusKey } from '@/lib/tickets/status-key';
import { allowedNextStatuses } from '@/lib/tickets/templates';

import { useOptimisticEdit } from './use-optimistic-edit';

/**
 * Moves a ticket to another status the way the header's Resolve button does: shown at once, a
 * toast with Undo, put back if the api refuses. `can` says whether this person may make the move
 * from the ticket's current status.
 */
export function useStatusMove(ticket: TicketItem) {
  const { t } = useI18n();
  const { can } = useSession();
  const canEdit = can('ticket.handle');
  const workflow = useWorkflow(canEdit);
  const mutations = useTicketMutations(ticket.key);
  const edit = useOptimisticEdit(ticket);

  const canMove = (target: TicketStatus) =>
    canEdit && allowedNextStatuses(workflow.data, ticket.status).includes(target);

  const move = (target: TicketStatus) => {
    const previous = ticket.status;
    edit.run({
      optimistic: { ...ticket, status: target },
      message: t('details.changed.status', { value: t(statusKey(target)) }),
      undo: allowedNextStatuses(workflow.data, target).includes(previous)
        ? () => {
            mutations.changeStatus.mutate(
              { status: previous },
              {
                onSuccess: () => {
                  toast(t('details.undone'));
                },
                onError: () => {
                  toast(t('details.undoFailed'));
                },
              },
            );
          }
        : undefined,
      send: (callbacks) => {
        mutations.changeStatus.mutate({ status: target }, callbacks);
      },
    });
  };

  return { can: canMove, move, pending: mutations.changeStatus.isPending };
}
