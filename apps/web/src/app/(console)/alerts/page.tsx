import { Suspense } from 'react';

import { AlertsPage } from '@/components/ops/alerts/alerts-page';

export default function Page() {
  // useSearchParams (the view and the open alert) needs a Suspense boundary.
  return (
    <Suspense>
      <AlertsPage />
    </Suspense>
  );
}
