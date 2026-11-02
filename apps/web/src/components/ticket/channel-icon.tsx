import type { TicketChannel } from '@watchtower/shared';
import { cn, TINT_CLASSES, type TintId } from '@watchtower/ui';
import {
  Cog,
  Footprints,
  Globe,
  Hash,
  type LucideIcon,
  Mail,
  MessageCircle,
  MessagesSquare,
  Phone,
  Webhook,
  Ellipsis,
} from 'lucide-react';

import { useT } from '@/i18n/provider';

const LOOK: Record<TicketChannel, { icon: LucideIcon; tone: TintId }> = {
  gmail: { icon: Mail, tone: 'blue' },
  line: { icon: MessageCircle, tone: 'green' },
  portal: { icon: Globe, tone: 'indigo' },
  discord: { icon: Hash, tone: 'purple' },
  webhook: { icon: Webhook, tone: 'slate' },
  internal: { icon: Cog, tone: 'slate' },
  phone: { icon: Phone, tone: 'teal' },
  walk_in: { icon: Footprints, tone: 'amber' },
  chat: { icon: MessagesSquare, tone: 'sky' },
  other: { icon: Ellipsis, tone: 'slate' },
};

/**
 * The channel a ticket came in on: a line icon in a small tinted circle (email blue, LINE green,
 * portal indigo, Discord purple), with its name for screen readers and as a tooltip.
 */
export function ChannelIcon({
  channel,
  className,
}: {
  channel: TicketChannel;
  className?: string;
}) {
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
