/**
 * The object store port and its S3 implementation live in `@watchtower/channels` since the portal
 * upload (T-140) needs the same store in the api (N6: one implementation; `packages/domain` may not
 * make HTTP calls, ADR-009). Re-exported here so the worker's imports stay as they were.
 */
export {
  createMemoryObjectStore,
  createS3ObjectStore,
  ObjectStoreError,
  type ObjectStore,
  type S3Options,
  type S3Settings,
} from '@watchtower/channels';
