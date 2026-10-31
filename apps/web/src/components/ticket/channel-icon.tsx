import type { ChannelType } from '@watchtower/shared';
import { Globe, type LucideIcon, Mail, MessageCircle, MessagesSquare, Webhook } from 'lucide-react';

import { useT } from '@/i18n/provider';

const ICONS: Record<ChannelType, LucideIcon> = {
  gmail: Mail,
  line: MessageCircle,
  portal: Globe,
  discord: MessagesSquare,
  webhook: Webhook,
};

/** The channel a ticket came in on: a line icon with its name for screen readers and as a tooltip. */
export function ChannelIcon({ channel, className }: { channel: ChannelType; className?: string }) {
  const t = useT();
  const Icon = ICONS[channel];
  const name = t(`channel.${channel}`);
  return (
    <span title={name} data-channel={channel} className={className}>
      <Icon aria-hidden className="size-3.5" />
      <span className="sr-only">{name}</span>
    </span>
  );
}
