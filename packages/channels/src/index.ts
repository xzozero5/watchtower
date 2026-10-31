import { CHANNEL_TYPES, type ChannelType } from '@watchtower/shared';

export const packageName = '@watchtower/channels';

export function isChannelType(value: string): value is ChannelType {
  return (CHANNEL_TYPES as readonly string[]).includes(value);
}
