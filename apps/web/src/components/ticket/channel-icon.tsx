import type { ChannelType } from '@watchtower/shared';
import { cn, TINT_CLASSES, type TintId } from '@watchtower/ui';
import { Globe, Hash, type LucideIcon, Mail, MessageCircle, Webhook } from 'lucide-react';

import { useT } from '@/i18n/provider';

const LOOK: Record<ChannelType, { icon: LucideIcon; tone: TintId }> = {
  gmail: { icon: Mail, tone: 'blue' },
  line: { icon: MessageCircle, tone: 'green' },
  portal: { icon: Globe, tone: 'indigo' },
  discord: { icon: Hash, tone: 'purple' },
  webhook: { icon: Webhook, tone: 'slate' },
};

/**
 * The channel a ticket came in on: a line icon in a small tinted circle (email blue, LINE green,
 * portal indigo, Discord purple), with its name for screen readers and as a tooltip.
 */
export function ChannelIcon({ channel, className }: { channel: ChannelType; className?: string }) {
  const t = useT();
  const { icon: Icon, tone } = LOOK[channel];
  const name = t(`channel.${channel}`);
  return (
    <span
      title={name}
      data-channel={channel}
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-full',
        TINT_CLASSES[tone].chip,
        className,
      )}
    >
      <Icon aria-hidden className={cn('size-3', TINT_CLASSES[tone].icon)} />
      <span className="sr-only">{name}</span>
    </span>
  );
}
