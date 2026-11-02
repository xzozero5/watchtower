import { ConsolePage } from '@/components/console-page';
import { OtherMailPage } from '@/components/other-mail/other-mail-page';

export default function Page() {
  return (
    <ConsolePage destination="otherMail">
      <OtherMailPage />
    </ConsolePage>
  );
}
