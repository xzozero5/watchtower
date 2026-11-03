import { OrgDetailPage } from '@/components/admin/orgs/org-detail-page';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrgDetailPage orgId={id} />;
}
