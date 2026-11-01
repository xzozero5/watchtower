import { ConsolePage } from '@/components/console-page';
import { HomePage } from '@/components/home/home-page';

export default function Page() {
  return (
    <ConsolePage destination="home">
      <HomePage />
    </ConsolePage>
  );
}
