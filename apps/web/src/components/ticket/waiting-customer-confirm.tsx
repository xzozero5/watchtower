'use client';

import { Button, Dialog, DialogContent } from '@watchtower/ui';

import { useI18n } from '@/i18n/provider';

/** The same customer-wait warning for the properties editor and an AI suggestion. */
export function WaitingCustomerConfirm({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('details.waitingConfirm.title')}
        description={t('details.waitingConfirm.body')}
        closeLabel={t('details.waitingConfirm.close')}
        footer={
          <>
            <Button
              onClick={() => {
                onOpenChange(false);
              }}
            >
              {t('details.waitingConfirm.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                onOpenChange(false);
                onConfirm();
              }}
            >
              {t('details.waitingConfirm.confirm')}
            </Button>
          </>
        }
      />
    </Dialog>
  );
}
