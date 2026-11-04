import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { uploadScanSummarySchema } from '@watchtower/shared';

import { RequirePermission } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { UploadScanGate } from '../storage/upload-scan-gate.js';

/**
 * Where an admin sees whether uploaded files are scanned for malware (ADR-022). When the scan is off
 * the answer carries `notice: "scan_off"`, which the admin screen shows as a notice. Read only.
 */
@ApiTags('admin')
@Controller('v1/admin/upload-scan')
@RequirePermission('integration.manage')
export class UploadScanController {
  constructor(@Inject(UploadScanGate) private readonly gate: UploadScanGate) {}

  @Get()
  @ApiOperation({
    summary: 'Malware scan mode and counts (head)',
    description:
      'The mode (`off` or `clamav`), `notice: "scan_off"` when uploaded files are not being scanned, ' +
      'and the number of files per scan state. Counts are zero while the scan is off.',
  })
  @ApiOkResponse({ standardSchema: uploadScanSummarySchema })
  async summary() {
    return parseResponse(uploadScanSummarySchema, await this.gate.summary());
  }
}
