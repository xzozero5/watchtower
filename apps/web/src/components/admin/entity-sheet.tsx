'use client';

import {
  Button,
  Dialog,
  DialogContent,
  Sheet,
  SheetContent,
  type SheetContentProps,
} from '@watchtower/ui';
import { CircleX } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { useT } from '@/i18n/provider';

export interface EntitySheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  /** Unsaved changes: closing then asks first. */
  dirty: boolean;
  pending: boolean;
  /** The id of the `<form>` inside; the footer's Save button submits it. */
  formId: string;
  submitLabel?: string;
  /** No Save button and fields locked: a lead looking at something only a head may change. */
  readOnly?: boolean;
  /** A sentence above the form: "Your changes were not saved." plus the api's explanation. */
  error?: string | null;
  /** Sits under the title, for tabs. */
  header?: SheetContentProps['header'];
  children: ReactNode;
}

/**
 * The right-hand sheet every admin edit uses (docs/06-UI-SPEC.md section 18.3): explicit Save,
 * "Saving…" while it runs, a summary of what failed, and a question before closing over unsaved
 * changes. Focus returns to the row that opened it because the sheet is a Radix dialog.
 */
export function EntitySheet({
  open,
  onClose,
  title,
  description,
  dirty,
  pending,
  formId,
  submitLabel,
  readOnly = false,
  error,
  header,
  children,
}: EntitySheetProps) {
  const t = useT();
  const [asking, setAsking] = useState(false);

  const requestClose = () => {
    if (pending) return;
    if (dirty && !readOnly) setAsking(true);
    else onClose();
  };

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
      >
        <SheetContent
          title={title}
          description={description}
          closeLabel={t('admin.common.close')}
          header={header}
          footer={
            <>
              <Button onClick={requestClose} disabled={pending}>
                {readOnly ? t('admin.common.close') : t('admin.common.cancel')}
              </Button>
              {readOnly ? null : (
                <Button variant="primary" type="submit" form={formId} disabled={pending}>
                  {pending ? t('admin.form.saving') : (submitLabel ?? t('admin.common.save'))}
                </Button>
              )}
            </>
          }
        >
          {error ? (
            <p
              role="alert"
              className="mb-3 flex items-start gap-1.5 rounded-md border border-border-strong px-3 py-2 text-sm"
            >
              <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
              <span>
                <span className="font-medium">{t('admin.form.notSaved')}</span> {error}
              </span>
            </p>
          ) : null}
          {children}
        </SheetContent>
      </Sheet>
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent
          title={t('admin.form.discardTitle')}
          description={t('admin.form.discardBody')}
          closeLabel={t('admin.common.close')}
          footer={
            <>
              <Button
                onClick={() => {
                  setAsking(false);
                }}
              >
                {t('admin.form.keepEditing')}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setAsking(false);
                  onClose();
                }}
              >
                {t('admin.form.discard')}
              </Button>
            </>
          }
        />
      </Dialog>
    </>
  );
}
