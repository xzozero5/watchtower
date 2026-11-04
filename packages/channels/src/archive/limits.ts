import { parseClamSize, type ArchiveLimits } from './archive-guard.js';

/** The archive limits from the config (`CLAMAV_MAX_FILE_SIZE`, `CLAMAV_MAX_SCAN_SIZE`, `CLAMAV_MAX_FILES`). */
export function archiveLimitsFromConfig(config: {
  readonly CLAMAV_MAX_FILE_SIZE: string;
  readonly CLAMAV_MAX_SCAN_SIZE: string;
  readonly CLAMAV_MAX_FILES: number;
}): ArchiveLimits {
  const member = parseClamSize(config.CLAMAV_MAX_FILE_SIZE);
  const total = parseClamSize(config.CLAMAV_MAX_SCAN_SIZE);
  if (member === null || total === null) throw new Error('CLAMAV_MAX_*_SIZE is not a size');
  return { maxMemberBytes: member, maxTotalBytes: total, maxMembers: config.CLAMAV_MAX_FILES };
}
