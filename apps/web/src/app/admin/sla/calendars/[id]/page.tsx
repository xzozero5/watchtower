import { CalendarPage } from '@/components/admin/sla/calendar-page';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CalendarPage calendarId={id} />;
}
