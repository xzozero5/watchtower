'use client';

import type { Message } from '@watchtower/shared';
import { Button, Dialog, DialogContent, toast, Tooltip } from '@watchtower/ui';
import { Star } from 'lucide-react';
import { useState } from 'react';

import { useI18n } from '@/i18n/provider';
import { canMarkGolden, goldenErrorKey } from '@/lib/ai/golden';
import { useGoldenPreview, useMarkGolden, useTicketGolden } from '@/lib/ai/grade-queries';
import { useSession } from '@/lib/auth/session';

/**
 * "Mark as golden answer" on a reply that was sent (T-302a, lead and head). The api keeps the text with
 * personal details removed and the drafter reads it as an example of tone. Once marked, the star is filled
 * and named "Golden answer": the state is the icon and the words, not the colour. Nothing is drawn for
 * anyone who may not mark, or for a message that is not a sent reply.
 */
export function GoldenMarkButton({ message, className }: { message: Message; className?: string }) {
  const { t } = useI18n();
  const { can, isClient } = useSession();
  const allowed = can('ai.golden.manage') && !isClient && canMarkGolden(message);
  const golden = useTicketGolden(message.ticketKey, allowed);
  const mark = useMarkGolden(message.ticketKey);
  const [open, setOpen] = useState(false);
  const [shareable, setShareable] = useState(false);
  const preview = useGoldenPreview(message.ticketKey, message.id, allowed && open && shareable);
  if (!allowed) return null;

  const marked =
    mark.isSuccess || (golden.data?.items.some((item) => item.messageId === message.id) ?? false);
  if (marked) {
    return (
      <Tooltip content={t('grade.golden.markedTip')}>
        <button
          type="button"
          aria-disabled="true"
          aria-label={t('grade.golden.marked')}
          data-golden="marked"
          className={className}
        >
          <Star aria-hidden className="size-3.5 fill-current text-tint-amber-icon" />
        </button>
      </Tooltip>
    );
  }
  const close = () => {
    setOpen(false);
    setShareable(false);
  };
  return (
    <>
      <Tooltip content={t('grade.golden.markTip')}>
        <button
          type="button"
          aria-label={t('grade.golden.mark')}
          disabled={mark.isPending}
          className={className}
          onClick={() => {
            setOpen(true);
          }}
        >
          <Star aria-hidden className="size-3.5" />
        </button>
      </Tooltip>
      {open ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next && !mark.isPending) close();
          }}
        >
          <DialogContent
            title={t('grade.golden.dialogTitle')}
            description={t('grade.golden.dialogBody')}
            closeLabel={t('admin.common.close')}
            footer={
              <>
                <Button onClick={close} disabled={mark.isPending}>
                  {t('admin.common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  disabled={mark.isPending}
                  onClick={() => {
                    mark.mutate(
                      { messageId: message.id, shareable },
                      {
                        onSuccess: () => {
                          toast(t('grade.golden.done'));
                          close();
                        },
                        onError: (error) => {
                          toast(t(`grade.golden.errors.${goldenErrorKey(error)}`));
                          close();
                        },
                      },
                    );
                  }}
                >
                  {t('grade.golden.confirm')}
                </Button>
              </>
            }
          >
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={shareable}
                onChange={(event) => {
                  setShareable(event.target.checked);
                }}
                className="mt-0.5 size-4"
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{t('grade.golden.shareable')}</span>
                <span className="text-muted-foreground">{t('grade.golden.shareableHelp')}</span>
              </span>
            </label>
            {shareable ? (
              <section
                aria-label={t('grade.golden.previewTitle')}
                className="mt-3 flex flex-col gap-1 text-sm"
              >
                <h3 className="font-medium">{t('grade.golden.previewTitle')}</h3>
                {preview.isPending ? (
                  <p className="text-muted-foreground">{t('grade.golden.previewLoading')}</p>
                ) : preview.isError ? (
                  <p role="alert" className="text-muted-foreground">
                    {t('grade.golden.previewError')}
                  </p>
                ) : (
                  <>
                    <p className="max-h-48 overflow-auto rounded-md border border-border p-2 break-words whitespace-pre-wrap">
                      {preview.data.text}
                    </p>
                    <p className="text-xs text-muted-foreground">{t('grade.golden.previewHelp')}</p>
                  </>
                )}
              </section>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
