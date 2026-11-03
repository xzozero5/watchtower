import { Suspense } from 'react';

import { IntegrationsPage } from '@/components/admin/integrations/integrations-page';

export default function Page() {
  // useSearchParams (the ?gmail_oauth= result the OAuth callback redirects with) needs a Suspense boundary.
  return (
    <Suspense>
      <IntegrationsPage />
    </Suspense>
  );
}
