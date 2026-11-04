import { constants, inflateRawSync } from 'node:zlib';

/**
 * "Reject at upload" for archives (T-182, B-007, ADR-022). ClamAV answers OK for a zip whose member is
 * larger than `MaxFileSize` even with `AlertExceedsMax yes` (only the first ~25 MB of that member is
 * looked at), so an archive that could hide such a member is refused before it is stored.
 *
 * A zip is read through its central directory by a small bounded parser (no dependency): the member
 * count, each member's declared uncompressed size, their sum, the names (path traversal) and nesting.
 * ZIP64 is read; a ZIP64 record that is not understood is refused. Because the central directory is
 * written by the sender, every deflate member is also inflated with an output cap of its declared size,
 * so a header that lies about the size is caught (the cost is bounded by `maxTotalBytes`).
 *
 * Nesting: an archive inside an archive is refused (depth limit 1), seen by the member's name and by
 * the first bytes of its content.
 *
 * Archive kinds whose listing is not read here (rar, 7z, gzip, bzip2, xz, tar, zstd, cab) are refused
 * as `archive_unsupported`; the caller applies this only when the malware scan is on. Pure functions.
 */

export interface ArchiveLimits {
  /** clamd `MaxFileSize`: the largest member that is scanned in full. */
  readonly maxMemberBytes: number;
  /** clamd `MaxScanSize`: the most data scanned from one archive. */
  readonly maxTotalBytes: number;
  /** clamd `MaxFiles`: the most members one archive may hold. */
  readonly maxMembers: number;
}

export const ARCHIVE_REFUSALS = [
  'archive_member_too_large',
  'archive_total_too_large',
  'archive_too_many_members',
  'archive_nested',
  'archive_path_traversal',
  'archive_unreadable',
  'archive_unsupported',
] as const;
export type ArchiveRefusal = (typeof ARCHIVE_REFUSALS)[number];

export type ArchiveVerdict =
  | { readonly status: 'not_archive' }
  | { readonly status: 'ok'; readonly members: number; readonly totalBytes: number }
  | { readonly status: 'refused'; readonly reason: ArchiveRefusal };

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_LENGTH = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_LENGTH = 20;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_MIN = 56;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_FIXED = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_FIXED = 30;
const MAX_COMMENT = 0xffff;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
/** Names longer than this are not a real archive's. */
const MAX_NAME_BYTES = 4096;
const ARCHIVE_EXTENSIONS = new Set([
  'zip',
  'jar',
  'apk',
  '7z',
  'rar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  'tar',
  'zst',
  'cab',
]);

class Refused extends Error {
  readonly reason: ArchiveRefusal;
  constructor(reason: ArchiveRefusal) {
    super(reason);
    this.reason = reason;
  }
}

const starts = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

/** What the bytes say they are, when it is an archive. */
export function detectArchive(bytes: Uint8Array): 'zip' | 'other' | null {
  if (
    starts(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    starts(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    starts(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return 'zip';
  }
  if (
    starts(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) || // rar
    starts(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || // 7z
    starts(bytes, [0x1f, 0x8b, 0x08]) || // gzip (deflate)
    // bzip2: "BZh", a level 1-9, then the first block's magic (so a text file that starts "BZh" is not one)
    (starts(bytes, [0x42, 0x5a, 0x68]) &&
      (bytes[3] ?? 0) >= 0x31 &&
      (bytes[3] ?? 0) <= 0x39 &&
      starts(bytes, [0x31, 0x41, 0x59, 0x26, 0x53, 0x59], 4)) ||
    starts(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) || // xz
    starts(bytes, [0x28, 0xb5, 0x2f, 0xfd]) || // zstd
    starts(bytes, [0x4d, 0x53, 0x43, 0x46]) || // cab "MSCF"
    starts(bytes, [0x75, 0x73, 0x74, 0x61, 0x72], 257) // tar "ustar"
  ) {
    return 'other';
  }
  return null;
}

function extensionOf(name: string | null): string {
  if (name === null) return '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * Decides whether an attachment may be stored. `filename` is only a hint: a file named like an archive
 * whose bytes are not recognisable is unreadable (nobody can list what is in it).
 */
export function inspectArchive(
  bytes: Uint8Array,
  limits: ArchiveLimits,
  filename: string | null = null,
): ArchiveVerdict {
  const kind = detectArchive(bytes);
  if (kind === 'other') return { status: 'refused', reason: 'archive_unsupported' };
  if (kind === null) {
    if (ARCHIVE_EXTENSIONS.has(extensionOf(filename))) {
      return { status: 'refused', reason: 'archive_unreadable' };
    }
    return { status: 'not_archive' };
  }
  try {
    const listing = listZip(bytes, limits);
    return { status: 'ok', members: listing.members, totalBytes: listing.totalBytes };
  } catch (error) {
    if (error instanceof Refused) return { status: 'refused', reason: error.reason };
    // Anything unexpected while reading hostile bytes: refuse (fail closed).
    return { status: 'refused', reason: 'archive_unreadable' };
  }
}

interface Entry {
  readonly name: string;
  readonly method: number;
  readonly encrypted: boolean;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Refused('archive_unreadable');
  return Number(value);
}

function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number {
  const lowest = Math.max(0, bytes.length - EOCD_LENGTH - MAX_COMMENT);
  for (let position = bytes.length - EOCD_LENGTH; position >= lowest; position -= 1) {
    if (view.getUint32(position, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(position + 20, true);
    if (position + EOCD_LENGTH + commentLength <= bytes.length) return position;
  }
  throw new Refused('archive_unreadable');
}

function listZip(
  bytes: Uint8Array,
  limits: ArchiveLimits,
): { members: number; totalBytes: number } {
  if (bytes.length < EOCD_LENGTH) throw new Refused('archive_unreadable');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes, view);
  let entries = view.getUint16(eocd + 10, true);
  let directorySize = view.getUint32(eocd + 12, true);
  let directoryOffset = view.getUint32(eocd + 16, true);
  let directoryEnd = eocd;
  if (entries === U16_MAX || directorySize === U32_MAX || directoryOffset === U32_MAX) {
    // ZIP64: the real numbers are in the zip64 end-of-central-directory record.
    const locator = eocd - ZIP64_LOCATOR_LENGTH;
    if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) {
      throw new Refused('archive_unreadable');
    }
    const recordOffset = safeNumber(view.getBigUint64(locator + 8, true));
    if (
      recordOffset + ZIP64_EOCD_MIN > bytes.length ||
      view.getUint32(recordOffset, true) !== ZIP64_EOCD_SIGNATURE
    ) {
      throw new Refused('archive_unreadable');
    }
    entries = safeNumber(view.getBigUint64(recordOffset + 32, true));
    directorySize = safeNumber(view.getBigUint64(recordOffset + 40, true));
    directoryOffset = safeNumber(view.getBigUint64(recordOffset + 48, true));
    directoryEnd = recordOffset;
  }
  if (entries > limits.maxMembers) throw new Refused('archive_too_many_members');
  // A zip with data in front (a self-extractor) has offsets relative to its own start.
  const start = directoryEnd - directorySize;
  if (start < 0) throw new Refused('archive_unreadable');
  const shift = start - directoryOffset;
  const list: Entry[] = [];
  let position = start;
  while (position < directoryEnd) {
    if (list.length >= limits.maxMembers) throw new Refused('archive_too_many_members');
    if (
      position + CENTRAL_FIXED > directoryEnd ||
      view.getUint32(position, true) !== CENTRAL_SIGNATURE
    ) {
      throw new Refused('archive_unreadable');
    }
    const flags = view.getUint16(position + 8, true);
    const method = view.getUint16(position + 10, true);
    let compressedSize = view.getUint32(position + 20, true);
    let uncompressedSize = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    let localOffset = view.getUint32(position + 42, true);
    const next = position + CENTRAL_FIXED + nameLength + extraLength + commentLength;
    if (next > directoryEnd || nameLength > MAX_NAME_BYTES) throw new Refused('archive_unreadable');
    const nameStart = position + CENTRAL_FIXED;
    const name = Buffer.from(bytes.subarray(nameStart, nameStart + nameLength)).toString('utf8');
    if (uncompressedSize === U32_MAX || compressedSize === U32_MAX || localOffset === U32_MAX) {
      // ZIP64 extended information (id 0x0001): only the fields whose 32-bit value is 0xFFFFFFFF, in
      // this order. Anything short of that is an archive this parser cannot size.
      let cursor = nameStart + nameLength;
      const extraEnd = cursor + extraLength;
      let found = false;
      while (cursor + 4 <= extraEnd) {
        const id = view.getUint16(cursor, true);
        const size = view.getUint16(cursor + 2, true);
        const dataStart = cursor + 4;
        if (dataStart + size > extraEnd) throw new Refused('archive_unreadable');
        if (id === 0x0001) {
          let at = dataStart;
          const take = (): number => {
            if (at + 8 > dataStart + size) throw new Refused('archive_unreadable');
            const value = safeNumber(view.getBigUint64(at, true));
            at += 8;
            return value;
          };
          if (uncompressedSize === U32_MAX) uncompressedSize = take();
          if (compressedSize === U32_MAX) compressedSize = take();
          if (localOffset === U32_MAX) localOffset = take();
          found = true;
          break;
        }
        cursor = dataStart + size;
      }
      if (!found) throw new Refused('archive_unreadable');
    }
    list.push({
      name,
      method,
      encrypted: (flags & 0x1) !== 0,
      compressedSize,
      uncompressedSize,
      localOffset: localOffset + shift,
    });
    position = next;
  }
  if (position !== directoryEnd || list.length !== entries) throw new Refused('archive_unreadable');

  // Declared numbers first: cheap, and enough to refuse the common cases without inflating anything.
  let total = 0;
  for (const entry of list) {
    if (isTraversal(entry.name)) throw new Refused('archive_path_traversal');
    if (ARCHIVE_EXTENSIONS.has(extensionOf(entry.name))) throw new Refused('archive_nested');
    if (entry.uncompressedSize > limits.maxMemberBytes) {
      throw new Refused('archive_member_too_large');
    }
    total += entry.uncompressedSize;
    if (total > limits.maxTotalBytes) throw new Refused('archive_total_too_large');
  }
  // The directory is the sender's word: inflate each member up to its declared size to see that it is
  // true, and look at the first bytes for an archive inside an archive.
  for (const entry of list) verifyMember(bytes, view, entry);
  return { members: list.length, totalBytes: total };
}

function isTraversal(name: string): boolean {
  if (name.includes('\0')) return true;
  const normalised = name.replaceAll('\\', '/');
  if (normalised.startsWith('/') || /^[A-Za-z]:/.test(normalised)) return true;
  return normalised.split('/').includes('..');
}

function verifyMember(bytes: Uint8Array, view: DataView, entry: Entry): void {
  if (entry.name.endsWith('/') && entry.uncompressedSize === 0) return; // a directory
  if (entry.encrypted) return; // not readable; clamd reports an encrypted archive as found
  if (entry.method !== 0 && entry.method !== 8) throw new Refused('archive_unreadable');
  const header = entry.localOffset;
  if (
    header < 0 ||
    header + LOCAL_FIXED > bytes.length ||
    view.getUint32(header, true) !== LOCAL_SIGNATURE
  ) {
    throw new Refused('archive_unreadable');
  }
  const dataStart =
    header + LOCAL_FIXED + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) throw new Refused('archive_unreadable');
  const data = bytes.subarray(dataStart, dataEnd);
  let content: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) throw new Refused('archive_unreadable');
    content = data;
  } else {
    try {
      // maxOutputLength: more than declared throws (the header lied); less is caught below.
      content = inflateRawSync(data, {
        maxOutputLength: Math.max(1, entry.uncompressedSize),
        finishFlush: constants.Z_SYNC_FLUSH,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      throw new Refused(
        code === 'ERR_BUFFER_TOO_LARGE' ? 'archive_member_too_large' : 'archive_unreadable',
      );
    }
    if (content.length !== entry.uncompressedSize) throw new Refused('archive_unreadable');
  }
  if (detectArchive(content.subarray(0, 512)) !== null) throw new Refused('archive_nested');
}

/** ClamAV size syntax (`25M`, `100M`, `512K`, `2G`, plain bytes) to bytes; null when it is not one. */
export function parseClamSize(value: string): number | null {
  const match = /^\s*(\d+)\s*([kKmMgG]?)\s*$/.exec(value);
  if (match === null) return null;
  const units: Readonly<Record<string, number>> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  return Number(match[1]) * (units[(match[2] ?? '').toLowerCase()] ?? 1);
}
