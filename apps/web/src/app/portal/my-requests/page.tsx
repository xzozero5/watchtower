import type { Metadata } from 'next';

import { MyRequestsPage } from '@/components/portal/my-requests-page';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function PortalMyRequestsPage() {
  return <MyRequestsPage />;
}
