import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { webpush } from '@watchtower/channels';

export const PUSH_VAPID_USAGE = [
  'usage: push-vapid.js --out <path>',
  'Makes a VAPID key pair for Web Push and writes it to <path> as two environment lines',
  '(WEB_PUSH_VAPID_PUBLIC, WEB_PUSH_VAPID_PRIVATE), readable by you only. The path must be outside the repository',
  'and must not exist yet. The private key is never printed; the public key is (it is not a secret).',
].join('\n');

export interface PushVapidIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** The directory holding `.git` above (or at) `start`, or null. */
function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * `push:vapid --out <path>`. Returns the exit code: 0 done, 1 could not write, 2 bad usage or a refused path.
 * The file is created with mode 0600 and never overwritten, so an existing key is not lost by accident
 * (rotating the key drops every browser's subscription: their `applicationServerKey` no longer matches).
 */
export async function runPushVapidCli(
  argv: readonly string[],
  io: PushVapidIo,
  cwd: string = process.cwd(),
): Promise<number> {
  const [flag, value, ...extra] = argv;
  if (flag !== '--out' || value === undefined || value === '' || extra.length > 0) {
    io.err(PUSH_VAPID_USAGE);
    return 2;
  }
  const target = resolve(cwd, value);
  const repo = findRepoRoot(cwd);
  if (repo !== null && isInside(repo, target)) {
    io.err(
      'refused: the key file must be outside the repository (a private key must never be committed)',
    );
    return 2;
  }
  if (existsSync(target)) {
    io.err('refused: that file already exists; it is not overwritten');
    return 2;
  }
  const keys = webpush.generateVapidKeys();
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      `WEB_PUSH_VAPID_PUBLIC=${keys.publicKey}\nWEB_PUSH_VAPID_PRIVATE=${keys.privateKey}\n`,
      { mode: 0o600, flag: 'wx' },
    );
  } catch {
    io.err('failed: the key file could not be written');
    return 1;
  }
  io.out(`wrote the VAPID key pair to ${target} (private key not shown)`);
  io.out(`public key (applicationServerKey): ${keys.publicKey}`);
  io.out('next: load the two lines into the api and worker environment, and set WEB_PUSH_SUBJECT');
  io.out(
    'to a mailto: or https: contact (for example mailto:ops@example.com). Web Push stays off until all three are set.',
  );
  return 0;
}
