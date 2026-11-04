import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { webpush } from '@watchtower/channels';
import { describe, expect, it } from 'vitest';

import { PUSH_VAPID_USAGE, runPushVapidCli } from './push-vapid-cli.js';

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe('push:vapid', () => {
  it('writes a matching key pair to the file and never prints the private key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-vapid-'));
    const target = join(dir, 'nested', 'vapid.env');
    const sink = io();
    expect(await runPushVapidCli(['--out', target], sink.io, dir)).toBe(0);
    const text = readFileSync(target, 'utf8');
    const publicKey = /^WEB_PUSH_VAPID_PUBLIC=(.+)$/m.exec(text)?.[1] ?? '';
    const privateKey = /^WEB_PUSH_VAPID_PRIVATE=(.+)$/m.exec(text)?.[1] ?? '';
    expect(webpush.vapidKeysMatch({ publicKey, privateKey })).toBe(true);
    // The public key may be shown; the private one is in the file only.
    expect(sink.out.join('\n')).toContain(publicKey);
    expect(sink.out.join('\n') + sink.err.join('\n')).not.toContain(privateKey);
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o077).toBe(0);
  });

  it('does not overwrite an existing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-vapid-'));
    const target = join(dir, 'vapid.env');
    writeFileSync(target, 'keep');
    const sink = io();
    expect(await runPushVapidCli(['--out', target], sink.io, dir)).toBe(2);
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });

  it('refuses a path inside a git repository', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'wt-repo-'));
    mkdirSync(join(repo, '.git'));
    const sink = io();
    expect(await runPushVapidCli(['--out', join(repo, 'vapid.env')], sink.io, repo)).toBe(2);
    expect(sink.err.join('\n')).toMatch(/outside the repository/);
  });

  it('prints usage for missing or extra arguments', async () => {
    for (const argv of [[], ['--out'], ['--out', 'a', 'b'], ['a']]) {
      const sink = io();
      expect(await runPushVapidCli(argv, sink.io)).toBe(2);
      expect(sink.err.join('\n')).toBe(PUSH_VAPID_USAGE);
    }
  });
});
