import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// The clamd settings the compose file mounts (T-155a C-2, C-5, C-6). The image's own defaults answer
// `OK` for a password-protected archive and for a file past the scan limits; these lines are what stop that.
const root = new URL('../../../../', import.meta.url);
const conf = readFileSync(new URL('config/clamav/clamd.conf', root), 'utf8');
const compose = readFileSync(new URL('docker-compose.yml', root), 'utf8');

function setting(name: string): string | undefined {
  const line = conf
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => !l.startsWith('#') && l.split(/\s+/)[0] === name);
  return line?.split(/\s+/)[1];
}

const service = (name: string) =>
  new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)\\n {2}\\S`).exec(compose)?.[1] ?? '';

describe('config/clamav/clamd.conf', () => {
  it.each(['AlertEncrypted', 'AlertEncryptedArchive', 'AlertEncryptedDoc', 'AlertExceedsMax'])(
    '%s is yes',
    (name) => {
      expect(setting(name)).toBe('yes');
    },
  );

  it('listens on 3310 and caps a stream at the size of the largest file we accept', () => {
    expect(setting('TCPSocket')).toBe('3310');
    expect(setting('StreamMaxLength')).toBe('25M');
  });

  it('is mounted read-only into the clamav container', () => {
    expect(service('clamav')).toContain('./config/clamav/clamd.conf:/etc/clamav/clamd.conf:ro');
  });
});

describe('the clamav container (C-5, C-6)', () => {
  it('is on the scan network only, shared with the worker and nobody else', () => {
    const clamav = service('clamav');
    expect(clamav).toMatch(/networks:\s*\n\s+- scan\s*\n/);
    expect(clamav).not.toMatch(/- default\b/);
    expect(service('worker')).toMatch(/networks:[\s\S]*- scan\b/);
    for (const name of ['api', 'web', 'caddy', 'minio', 'postgres', 'redis']) {
      expect(service(name)).not.toMatch(/- scan\b/);
    }
    expect(compose).toMatch(/\nnetworks:[\s\S]*\n {2}scan: \{\}/);
  });

  it('is hardened: no new privileges, capabilities dropped, a process limit', () => {
    const clamav = service('clamav');
    expect(clamav).toContain('no-new-privileges:true');
    expect(clamav).toMatch(/cap_drop:\s*\n\s+- ALL/);
    expect(clamav).toMatch(/pids_limit: \d+/);
    expect(clamav).not.toMatch(/privileged|SYS_ADMIN|NET_ADMIN/);
  });
});
