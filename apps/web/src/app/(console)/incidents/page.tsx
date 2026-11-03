import { Suspense } from 'react';

import { IncidentsPage } from '@/components/ops/incidents/incidents-page';

export default function Page() {
  // useSearchParams (the scope and the open incident) needs a Suspense boundary.
  return (
    <Suspense>
      <IncidentsPage />
    </Suspense>
  );
}
