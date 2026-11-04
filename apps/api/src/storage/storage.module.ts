import { Global, Module } from '@nestjs/common';
import { createS3ObjectStore, type ObjectStore } from '@watchtower/channels';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { UploadScanGate } from './upload-scan-gate.js';

/** DI token of the object store (MinIO locally, GCS through its S3 endpoint). Inject with `@Inject(OBJECT_STORE)`. */
export const OBJECT_STORE = Symbol('OBJECT_STORE');
export type { ObjectStore };

/**
 * The api's handle on object storage, built from the S3 settings the config already has. The same
 * implementation as the worker's (`@watchtower/domain`): the worker writes inbound mail and LINE
 * media, the api writes portal uploads (T-140) and reads any attachment back for a signed-in person.
 */
@Global()
@Module({
  providers: [
    {
      provide: OBJECT_STORE,
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig): ObjectStore =>
        createS3ObjectStore({
          endpoint: config.S3_ENDPOINT,
          region: config.S3_REGION,
          bucket: config.S3_BUCKET,
          accessKey: config.S3_ACCESS_KEY,
          secretKey: config.S3_SECRET_KEY,
        }),
    },
    // The verdicts of the malware scan (ADR-022); every download and listing of an upload asks it.
    UploadScanGate,
  ],
  exports: [OBJECT_STORE, UploadScanGate],
})
export class StorageModule {}
