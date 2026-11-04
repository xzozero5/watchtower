import { Module } from '@nestjs/common';

import { StaffUploadsService } from './staff-uploads.service.js';
import { UploadScanController } from './upload-scan.controller.js';
import { UploadsController } from './uploads.controller.js';

/**
 * Staff uploads (images and files on tickets, shift notes, handoffs, incident notes). The service is
 * exported so those modules can turn the `attachmentIds` they receive into references.
 */
@Module({
  controllers: [UploadsController, UploadScanController],
  providers: [StaffUploadsService],
  exports: [StaffUploadsService],
})
export class UploadsModule {}
