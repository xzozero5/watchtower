import { Suspense } from 'react';

import { ServicesPage } from '@/components/ops/alerts/services-page';

export default function Page() {
  // useSearchParams (the open tab) needs a Suspense boundary.
  return (
    <Suspense>
      <ServicesPage />
    </Suspense>
  );
}
