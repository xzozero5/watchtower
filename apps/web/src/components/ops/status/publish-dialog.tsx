'use client';

import { Button, Dialog, DialogContent } from '@watchtower/ui';
import { CircleX } from 'lucide-react';

import { useI18n } from '@/i18n/provider';

/**
 * The last step before something goes public (N3): the exact words, who is told, and a button that
 * says what it does. Nothing is published by opening this; only the button inside does.
 */
export function PublishDialog({
  title,
  description,
  heading,
  body,
  confirmLabel,
  onConfirm,
  onClose,
  pending,
  error,
}: {
  title: string;
  description: string;
  /** The title of what will be published, as the public will read it. */
  heading: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        title={title}
        description={description}
        closeLabel={t('ops.common.close')}
        footer={
          <>
            <Button onClick={onClose} disabled={pending}>
              {t('ops.common.cancel')}
            </Button>
            <Button variant="primary" onClick={onConfirm} disabled={pending}>
              {pending ? t('ops.common.saving') : confirmLabel}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 px-5 py-3 text-sm">
          <p className="text-xs font-medium text-muted-foreground">
            {t('ops.statusAdmin.publicWording')}
          </p>
          <blockquote className="max-h-48 overflow-y-auto rounded-md bg-surface-muted px-3 py-2">
            <p className="font-medium break-words">{heading}</p>
            <p className="whitespace-pre-wrap break-words">{body}</p>
          </blockquote>
          {error ? (
            <p role="alert" className="flex items-start gap-1 font-medium text-danger">
              <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
