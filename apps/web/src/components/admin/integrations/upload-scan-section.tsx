'use client';

import { Alert, HelpHint } from '@watchtower/ui';
import { ShieldAlert, ShieldCheck } from 'lucide-react';

import { LoadError, TableSkeleton } from '@/components/admin/admin-page';
import { useT } from '@/i18n/provider';
import { useUploadScan } from '@/lib/admin/queries';

const STATES = ['pending', 'clean', 'infected', 'error'] as const;

/**
 * Whether uploaded files are scanned for malware (T-155, ADR-022), read only. When the scan is off the
 * api sets `notice: "scan_off"` and this says so in words (and an icon, not colour alone).
 */
export function UploadScanSection() {
  const t = useT();
  const scan = useUploadScan();
  return (
    <section aria-labelledby="upload-scan-heading" className="flex flex-col gap-3">
      <div className="flex items-center gap-1">
        <h2 id="upload-scan-heading" className="text-base font-semibold">
          {t('admin.integrations.uploadScan.heading')}
        </h2>
        <HelpHint
          label={t('admin.moreInfo', { topic: t('admin.integrations.uploadScan.heading') })}
        >
          {t('admin.integrations.uploadScan.hint')}
        </HelpHint>
      </div>
      {scan.isPending ? (
        <TableSkeleton rows={1} />
      ) : scan.isError ? (
        <LoadError
          message={t('admin.integrations.uploadScan.loadError')}
          onRetry={() => void scan.refetch()}
        />
      ) : (
        <>
          {scan.data.notice === 'scan_off' ? (
            <Alert tone="info" title={t('admin.integrations.uploadScan.scanOff')}>
              {t('admin.integrations.uploadScan.scanOffHint')}
            </Alert>
          ) : (
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <ShieldCheck aria-hidden className="size-4" />
              {t('admin.integrations.uploadScan.modeOn')}
            </p>
          )}
          <ul
            aria-label={t('admin.integrations.uploadScan.counts')}
            className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground"
          >
            {STATES.map((state) => (
              <li key={state} className="flex items-center gap-1">
                {state === 'infected' && scan.data.counts.infected > 0 ? (
                  <ShieldAlert aria-hidden className="size-3.5 text-danger" />
                ) : null}
                {t(`admin.integrations.uploadScan.${state}`, { count: scan.data.counts[state] })}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
