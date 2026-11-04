import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

import { baseEnvShape } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { archiveLimitsFromConfig } from './limits.js';
import { inspectArchive, parseClamSize, type ArchiveLimits } from './archive-guard.js';

interface Member {
  readonly name: string;
  readonly data: Buffer;
  /** What the central directory claims, when it should lie. */
  readonly declaredSize?: number;
  readonly stored?: boolean;
}

/** A zip written by hand, so a test can make a bomb, a lie, a traversal name or ZIP64 records. */
function buildZip(members: readonly Member[], options: { zip64?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8');
    const body = member.stored === true ? member.data : deflateRawSync(member.data);
    const method = member.stored === true ? 0 : 8;
    const declared = member.declaredSize ?? member.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const extra = options.zip64 === true ? Buffer.alloc(4 + 8 * 3) : Buffer.alloc(0);
    if (options.zip64 === true) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(declared), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(45, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(options.zip64 === true ? 0xffffffff : body.length, 20);
    central.writeUInt32LE(options.zip64 === true ? 0xffffffff : declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(options.zip64 === true ? 0xffffffff : offset, 42);
    centrals.push(central, name, extra);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const parts = [...locals, directory];
  if (options.zip64 === true) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeBigUInt64LE(BigInt(members.length), 24);
    record.writeBigUInt64LE(BigInt(members.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(record, locator);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
  } else {
    eocd.writeUInt16LE(members.length, 8);
    eocd.writeUInt16LE(members.length, 10);
    eocd.writeUInt32LE(directory.length, 12);
    eocd.writeUInt32LE(offset, 16);
  }
  parts.push(eocd);
  return Buffer.concat(parts);
}

const LIMITS: ArchiveLimits = {
  maxMemberBytes: 1_000_000,
  maxTotalBytes: 3_000_000,
  maxMembers: 5,
};
const text = (size: number): Buffer => Buffer.alloc(size, 0x61);

function reason(bytes: Uint8Array, filename: string | null = null): string {
  const verdict = inspectArchive(bytes, LIMITS, filename);
  return verdict.status === 'refused' ? verdict.reason : verdict.status;
}

describe('inspectArchive', () => {
  it('passes a normal zip and says how much is in it', () => {
    const zip = buildZip([
      { name: 'a.txt', data: text(1000) },
      { name: 'dir/', data: Buffer.alloc(0), stored: true },
      { name: 'dir/b.txt', data: text(500), stored: true },
    ]);
    expect(inspectArchive(zip, LIMITS)).toEqual({ status: 'ok', members: 3, totalBytes: 1500 });
  });

  it('leaves files that are not archives alone', () => {
    expect(reason(Buffer.from('%PDF-1.7 hello'))).toBe('not_archive');
    expect(reason(Buffer.from('hello'), 'notes.txt')).toBe('not_archive');
  });

  it('refuses a small zip bomb: a member over the member limit', () => {
    const bomb = buildZip([{ name: 'big.bin', data: Buffer.alloc(1_500_000) }]);
    expect(bomb.length).toBeLessThan(5000);
    expect(reason(bomb)).toBe('archive_member_too_large');
  });

  it('refuses members that together pass the total limit', () => {
    const members = [1, 2, 3, 4].map((n) => ({ name: `m${String(n)}`, data: text(900_000) }));
    expect(reason(buildZip(members))).toBe('archive_total_too_large');
  });

  it('refuses more members than the ceiling', () => {
    const members = Array.from({ length: 6 }, (_, n) => ({ name: `m${String(n)}`, data: text(1) }));
    expect(reason(buildZip(members))).toBe('archive_too_many_members');
  });

  it('refuses a header that lies about the size (declared small, really big)', () => {
    const lie = buildZip([{ name: 'big.bin', data: Buffer.alloc(2_000_000), declaredSize: 10 }]);
    expect(reason(lie)).toBe('archive_member_too_large');
  });

  it('refuses a header that says more than the member really holds', () => {
    expect(reason(buildZip([{ name: 'a.txt', data: text(10), declaredSize: 20 }]))).toBe(
      'archive_unreadable',
    );
  });

  it.each(['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:\\x.txt', 'a\\..\\b.txt'])(
    'refuses the path %s',
    (name) => {
      expect(reason(buildZip([{ name, data: text(5) }]))).toBe('archive_path_traversal');
    },
  );

  it('refuses a zip inside a zip (by name and by content)', () => {
    const inner = buildZip([{ name: 'a.txt', data: text(5) }]);
    expect(reason(buildZip([{ name: 'inner.zip', data: inner }]))).toBe('archive_nested');
    expect(reason(buildZip([{ name: 'renamed.dat', data: inner }]))).toBe('archive_nested');
    expect(reason(buildZip([{ name: 'renamed.dat', data: inner, stored: true }]))).toBe(
      'archive_nested',
    );
  });

  it('reads ZIP64 records and applies the same limits', () => {
    const fine = buildZip([{ name: 'a.txt', data: text(100) }], { zip64: true });
    expect(inspectArchive(fine, LIMITS)).toEqual({ status: 'ok', members: 1, totalBytes: 100 });
    const bomb = buildZip([{ name: 'big.bin', data: Buffer.alloc(1_500_000) }], { zip64: true });
    expect(reason(bomb)).toBe('archive_member_too_large');
  });

  it('refuses a ZIP64 archive it cannot read (no zip64 record) instead of passing it', () => {
    const zip = buildZip([{ name: 'a.txt', data: text(100) }], { zip64: true });
    // Break the zip64 locator signature.
    const at = zip.length - 22 - 20;
    const broken = Buffer.from(zip);
    broken.writeUInt32LE(0, at);
    expect(reason(broken)).toBe('archive_unreadable');
  });

  it('refuses a truncated or damaged zip', () => {
    const zip = buildZip([{ name: 'a.txt', data: text(100) }]);
    expect(reason(zip.subarray(0, zip.length - 30))).toBe('archive_unreadable');
    expect(reason(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(40)]))).toBe(
      'archive_unreadable',
    );
  });

  it.each([
    ['rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]],
    ['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]],
    ['gzip', [0x1f, 0x8b, 0x08, 0x00]],
    ['bzip2', [0x42, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59]],
    ['xz', [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
  ])('refuses %s: its listing is not read', (_name, signature) => {
    expect(reason(Uint8Array.from([...signature, ...new Array<number>(40).fill(1)]))).toBe(
      'archive_unsupported',
    );
  });

  it('does not take a text file that starts with BZh for bzip2', () => {
    expect(reason(Buffer.from('BZh9 is a log prefix, not an archive'), 'a.log')).toBe(
      'not_archive',
    );
  });

  it('refuses a file named like an archive whose bytes are not one', () => {
    expect(reason(Buffer.from('not really'), 'photos.zip')).toBe('archive_unreadable');
  });
});

describe('parseClamSize and clamd.conf', () => {
  it('reads ClamAV size syntax', () => {
    expect(parseClamSize('25M')).toBe(25 * 1024 * 1024);
    expect(parseClamSize('512K')).toBe(512 * 1024);
    expect(parseClamSize('1G')).toBe(1024 ** 3);
    expect(parseClamSize('100')).toBe(100);
    expect(parseClamSize('abc')).toBeNull();
  });

  it('the defaults the worker uses are the numbers in config/clamav/clamd.conf', () => {
    const defaults = archiveLimitsFromConfig(
      z
        .object({
          CLAMAV_MAX_FILE_SIZE: baseEnvShape.CLAMAV_MAX_FILE_SIZE,
          CLAMAV_MAX_SCAN_SIZE: baseEnvShape.CLAMAV_MAX_SCAN_SIZE,
          CLAMAV_MAX_FILES: baseEnvShape.CLAMAV_MAX_FILES,
        })
        .parse({}),
    );
    const conf = readFileSync(
      new URL('../../../../config/clamav/clamd.conf', import.meta.url),
      'utf8',
    );
    const value = (key: string): string => {
      const match = new RegExp(`^${key}\\s+(\\S+)\\s*$`, 'm').exec(conf);
      if (match?.[1] === undefined) throw new Error(`${key} missing in clamd.conf`);
      return match[1];
    };
    expect(defaults.maxMemberBytes).toBe(parseClamSize(value('MaxFileSize')));
    expect(defaults.maxTotalBytes).toBe(parseClamSize(value('MaxScanSize')));
    expect(defaults.maxMembers).toBe(Number(value('MaxFiles')));
  });
});
