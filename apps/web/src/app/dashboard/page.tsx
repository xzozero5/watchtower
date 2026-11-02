import { ConsolePage } from '@/components/console-page';
import { DashboardPage } from '@/components/dashboard/dashboard-page';

export default function Page() {
  return (
    <ConsolePage destination="dashboard">
      <DashboardPage />
    </ConsolePage>
  );
}
