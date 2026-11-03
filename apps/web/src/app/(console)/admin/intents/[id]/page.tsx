import { IntentDetailPage } from '@/components/admin/intents/intent-detail-page';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <IntentDetailPage intentId={id} />;
}
