import { Suspense } from 'react';

import { StartPage } from '@/components/start-page';

export default function Page() {
  // useSearchParams (the ?next= destination) needs a Suspense boundary.
  return (
    <Suspense>
      <StartPage />
    </Suspense>
  );
}
