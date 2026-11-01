'use client';

import { Button, Dialog, DialogContent } from '@watchtower/ui';
import { CircleX } from 'lucide-react';

import { useT } from '@/i18n/provider';

/**
 * "Disable Mana K.? Their sessions end now." A question naming the item, a plain verb for the
 * button (never a red fill: the weight comes from the words), and the failure shown in the dialog.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  pending: boolean;
  error?: string | null;
}) {
  const t = useT();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent
        title={title}
        description={description}
        closeLabel={t('admin.common.close')}
        footer={
          <>
            <Button
              onClick={() => {
                onOpenChange(false);
              }}
              disabled={pending}
            >
              {t('admin.common.cancel')}
            </Button>
            <Button variant="primary" onClick={onConfirm} disabled={pending}>
              {pending ? t('admin.form.saving') : confirmLabel}
            </Button>
          </>
        }
      >
        {error ? (
          <p role="alert" className="flex items-start gap-1 text-sm font-medium text-danger">
            <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
