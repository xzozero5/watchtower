import type { Metadata } from 'next';

import { Confirmation } from '@/components/portal/confirmation';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function SubmittedPage() {
  return <Confirmation />;
}
