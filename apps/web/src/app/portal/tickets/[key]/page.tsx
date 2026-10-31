import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { TrackingPage } from '@/components/portal/tracking-page';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Ticket numbers are a prefix, a dash and digits (`OPS-12`); anything else is not one of ours. */
const TICKET_KEY = /^[A-Za-z0-9_-]{3,32}$/;

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export default async function TicketTrackingPage({ params }: { params: Promise<{ key: string }> }) {
  const key = decode((await params).key);
  if (!TICKET_KEY.test(key)) notFound();
  return <TrackingPage ticketKey={key} />;
}
