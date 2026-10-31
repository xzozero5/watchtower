import { Suspense } from 'react';

import { LoginPage } from '@/components/login/login-page';

export default function Page() {
  // useSearchParams (the ?error= from a failed sign-in) needs a Suspense boundary.
  return (
    <Suspense>
      <LoginPage />
    </Suspense>
  );
}
