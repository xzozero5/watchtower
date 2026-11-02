import { CHANNEL_TYPES, type ChannelType } from '@watchtower/shared';

export const packageName = '@watchtower/channels';

export function isChannelType(value: string): value is ChannelType {
  return (CHANNEL_TYPES as readonly string[]).includes(value);
}

export * from './common/index.js';
export * as discord from './discord/index.js';
export * as gmail from './gmail/index.js';
export * as line from './line/index.js';
export {
  createMemoryObjectStore,
  createS3ObjectStore,
  ObjectStoreError,
  type ObjectStore,
  type S3Options,
  type S3Settings,
} from './storage/object-store.js';
