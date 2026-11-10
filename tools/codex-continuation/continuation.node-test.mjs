import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWrite, date, execute, read, withLock } from './continuation.mjs';
import { quotaDecision, readQuota, synchronizeQuota } from './quota.mjs';

const now = '2026-11-06T00:00:00.000Z';
const five = '2026-11-06T05:00:00.000Z';
const week = '2026-11-13T00:00:00.000Z';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'checkpoint.json');
}

test('state lifecycle respects both reset windows and explicit resume', (t) => {
  const file = fixture(t);
  assert.equal(execute(file, 'status'), null);
  const claimed = execute(
    file,
    'checkpoint',
    { task: 'T-437', state: 'running', 'owner-pid': String(process.pid) },
    now,
  );
  assert.equal(claimed.state, 'running');
  assert.throws(() =>
    execute(file, 'checkpoint', { state: 'running', 'owner-pid': String(process.pid) }, now),
  );
  assert.throws(() => execute(file, 'pause', {}, now));
  const paused = execute(
    file,
    'pause',
    { 'five-hour-reset': five, 'weekly-reset': week, 'claim-token': claimed.claimToken },
    now,
  );
  assert.equal(paused.nextEligibleAt, week);
  assert.throws(() => execute(file, 'checkpoint', { state: 'running' }, five));
  assert.equal(execute(file, 'status', {}, week).state, 'waiting_limit');
  assert.throws(() =>
    execute(file, 'checkpoint', { state: 'running', 'weekly-reset': five }, week),
  );
  const resumed = execute(
    file,
    'checkpoint',
    { state: 'running', 'owner-pid': String(process.pid) },
    week,
  );
  assert.equal(resumed.state, 'running');
  assert.equal(
    execute(file, 'checkpoint', { state: 'blocked', 'claim-token': resumed.claimToken }, week)
      .state,
    'blocked',
  );
  assert.equal(execute(file, 'complete', {}, week).state, 'completed');
  assert.throws(() => execute(file, 'checkpoint', { state: 'running' }, week));
  assert.equal(execute(file, 'checkpoint', { task: 'T-438' }, week).state, 'ready');
});

test('available weekly window uses now, so only exhausted 5h window delays resume', (t) => {
  const file = fixture(t);
  execute(file, 'checkpoint', { task: 'T-437' }, now);
  assert.equal(
    execute(file, 'pause', { 'five-hour-reset': five, 'weekly-reset': now }, now).nextEligibleAt,
    five,
  );
  assert.equal(
    execute(file, 'checkpoint', { state: 'running', 'owner-pid': String(process.pid) }, five).state,
    'running',
  );
});

test('dead long-lived runner can be reclaimed; live runner requires token to release', (t) => {
  const file = fixture(t);
  const claimed = execute(
    file,
    'checkpoint',
    { task: 'T-437', state: 'running', 'owner-pid': String(process.pid) },
    now,
  );
  assert.throws(() => execute(file, 'complete', {}, now));
  assert.throws(() =>
    execute(
      file,
      'checkpoint',
      { state: 'running', 'owner-pid': String(process.pid), 'claim-token': claimed.claimToken },
      now,
    ),
  );
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  atomicWrite(file, { ...claimed, ownerPid: child.pid });
  assert.notEqual(
    execute(file, 'checkpoint', { state: 'running', 'owner-pid': String(process.pid) }, now)
      .claimToken,
    claimed.claimToken,
  );
});

test('invalid dates and metadata fail closed', (t) => {
  for (const value of [
    'tomorrow',
    '2026-02-30T00:00:00Z',
    '2026-11-06',
    '2026-11-06T00:00:00+07:00',
    null,
  ])
    assert.throws(() => date(value));
  const file = fixture(t);
  assert.throws(() => execute(file, 'checkpoint', { task: 'T-437', prompt: 'forbidden' }, now));
  assert.throws(() => execute(file, 'checkpoint', { task: 'invalid' }, now));
  execute(file, 'checkpoint', { task: 'T-437' }, now);
  assert.throws(() => execute(file, 'checkpoint', { task: 'T-438' }, now));
  fs.writeFileSync(file, '{');
  assert.throws(() => read(file));
});

test('one known reset cannot admit a runner while the other window is unknown', (t) => {
  for (const reset of ['five-hour-reset', 'weekly-reset']) {
    const file = fixture(t);
    execute(file, 'checkpoint', { task: 'T-437' }, now);
    for (const state of ['ready', 'running']) {
      assert.throws(() =>
        execute(
          file,
          'checkpoint',
          {
            state,
            ...(state === 'running' ? { 'owner-pid': String(process.pid) } : {}),
            [reset]: five,
          },
          now,
        ),
      );
      assert.equal(read(file).state, 'ready');
    }
  }
});

test('failed atomic replacement preserves prior checkpoint and cleans temporary file', (t) => {
  const file = fixture(t);
  const record = execute(file, 'checkpoint', { task: 'T-437' }, now);
  assert.throws(() =>
    atomicWrite(file, { ...record, state: 'blocked' }, () => {
      throw new Error('simulated failure');
    }),
  );
  assert.deepEqual(read(file), record);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['checkpoint.json']);
  atomicWrite(file, { ...record, state: 'blocked' });
  assert.equal(read(file).state, 'blocked');
});

test('live lock excludes writers including other processes; dead owner recovers', (t) => {
  const file = fixture(t);
  withLock(file, () => {
    assert.throws(() => withLock(file, () => assert.fail('overlap')));
    const child = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import {withLock} from ${JSON.stringify(new URL('./continuation.mjs', import.meta.url).href)}; withLock(${JSON.stringify(file)}, () => {});`,
    ]);
    assert.notEqual(child.status, 0);
  });
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: child.pid }));
  assert.equal(
    withLock(file, () => 'recovered'),
    'recovered',
  );
  assert.equal(fs.existsSync(`${file}.lock`), false);
  fs.writeFileSync(`${file}.lock`, '{}');
  assert.throws(() => withLock(file, () => {}));
  assert.equal(fs.existsSync(`${file}.lock`), true);
});

test('CLI emits only safe metadata and rejects arbitrary payloads', (t) => {
  const file = fixture(t);
  const dir = path.dirname(file);
  spawnSync('git', ['init', '-q', dir]);
  const cli = new URL('./cli.mjs', import.meta.url);
  const result = spawnSync(
    process.execPath,
    [cli.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'checkpoint', '--task', 'T-437'],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).taskId, 'T-437');
  const rejected = spawnSync(
    process.execPath,
    [cli.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'checkpoint', '--prompt', 'sensitive-sentinel'],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(rejected.status, 1);
  assert.equal(`${rejected.stdout}${rejected.stderr}`.includes('sensitive-sentinel'), false);
});

function quota(used = 94, weeklyUsed = 20) {
  return {
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        primary: { usedPercent: used, windowDurationMins: 300, resetsAt: Date.parse(five) / 1000 },
        secondary: {
          usedPercent: weeklyUsed,
          windowDurationMins: 10080,
          resetsAt: Date.parse(week) / 1000,
        },
      },
    },
  };
}

test('account quota threshold is inclusive and checks each applicable window', () => {
  assert.equal(quotaDecision(quota(94.99), now, now).action, 'continue');
  assert.equal(quotaDecision(quota(95), now, now).action, 'pause');
  assert.equal(quotaDecision(quota(100), now, now).action, 'pause');
  assert.equal(quotaDecision(quota(20, 95), now, now).nextEligibleAt, week);
  assert.equal(quotaDecision(quota(95, 95), now, now).nextEligibleAt, week);
});

test('quota never substitutes context tokens, missing buckets or stale observations', () => {
  for (const value of [
    null,
    {},
    { token_count: 1, model_context_window: 200000 },
    { rateLimits: quota().rateLimitsByLimitId.codex, rateLimitsByLimitId: {} },
  ]) {
    assert.equal(quotaDecision(value, now, now).action, 'blocked');
  }
  assert.equal(quotaDecision(quota(), now, five).action, 'blocked');
  assert.equal(quotaDecision(quota(), five, now).action, 'blocked');
  for (const invalid of [-1, 101, '95', null, NaN]) {
    assert.equal(quotaDecision(quota(invalid), now, now).action, 'blocked');
  }
  const missing = quota();
  delete missing.rateLimitsByLimitId.codex.secondary;
  assert.equal(quotaDecision(missing, now, now).action, 'blocked');
  missing.rateLimitsByLimitId.codex.secondary = null;
  assert.equal(quotaDecision(missing, now, now).action, 'continue');
  missing.rateLimitsByLimitId.codex.primary.resetsAt = Date.parse(now) / 1000;
  assert.equal(quotaDecision(missing, now, now).action, 'blocked');
});

test('threshold checkpoints pause and only a fresh available read resumes exactly one runner', (t) => {
  const file = fixture(t);
  const task = 'T-448';
  const running = synchronizeQuota(
    file,
    quotaDecision(quota(20), now, now),
    { task, ownerPid: process.pid },
    now,
  );
  assert.equal(running.state, 'running');
  assert.throws(() => synchronizeQuota(file, quotaDecision(quota(95), now, now), { task }, now));
  const paused = synchronizeQuota(
    file,
    quotaDecision(quota(95), now, now),
    { task, claimToken: running.claimToken },
    now,
  );
  assert.equal(paused.state, 'waiting_limit');
  assert.equal(paused.nextEligibleAt, five); // Weekly is available, do not wait a week.
  assert.equal(
    synchronizeQuota(file, quotaDecision(quota(20), now, now), { task }, now).state,
    'waiting_limit',
  );
  // Passing the timer does not refresh account quota.
  assert.equal(
    synchronizeQuota(file, quotaDecision(quota(20), now, now), { task }, five).state,
    'blocked',
  );
  const reset = quota(1);
  reset.rateLimitsByLimitId.codex.primary.resetsAt = Date.parse(five) / 1000 + 18000;
  const resumed = synchronizeQuota(
    file,
    quotaDecision(reset, five, five),
    { task, ownerPid: process.pid },
    five,
  );
  assert.equal(resumed.state, 'running');
  assert.throws(() =>
    synchronizeQuota(file, quotaDecision(reset, five, five), { task, ownerPid: process.pid }, five),
  );
  const current = synchronizeQuota(
    file,
    quotaDecision(reset, five, five),
    { task, ownerPid: process.pid, claimToken: resumed.claimToken },
    five,
  );
  assert.equal(current.claimToken, resumed.claimToken);
  assert.throws(() =>
    synchronizeQuota(file, quotaDecision(reset, five, five), { task: 'T-449' }, five),
  );
  execute(file, 'complete', { 'claim-token': resumed.claimToken }, five);
  assert.equal(
    synchronizeQuota(file, quotaDecision(reset, five, five), { task }, five).state,
    'completed',
  );
});

test('unknown quota preserves checkpoints and cannot release an active owner', (t) => {
  const file = fixture(t);
  const task = 'T-448';
  const running = execute(
    file,
    'checkpoint',
    { task, state: 'running', 'owner-pid': String(process.pid) },
    now,
  );
  const unknown = quotaDecision({}, now, now);
  assert.throws(() => synchronizeQuota(file, unknown, { task }, now));
  assert.deepEqual(read(file), running);
  assert.equal(
    synchronizeQuota(file, unknown, { task, claimToken: running.claimToken }, now).state,
    'blocked',
  );
});

test('RPC quota reader handshakes and invokes only the read endpoint without exposing raw data', async () => {
  const fake = `
    import { createInterface } from 'node:readline';
    let step = 0;
    createInterface({input:process.stdin}).on('line', line => {
      const msg = JSON.parse(line);
      if(step === 0 && msg.method === 'initialize') {
        step++; console.log(JSON.stringify({id:1,result:{userAgent:'private-sentinel'}}));
      } else if(step === 1 && msg.method === 'initialized') step++;
      else if(step === 2 && msg.method === 'account/rateLimits/read') {
        step++; console.log(JSON.stringify({id:2,result:${JSON.stringify(quota())}}));
      } else process.exit(19);
    });`;
  const result = await readQuota({
    executable: process.execPath,
    args: ['--input-type=module', '-e', fake],
  });
  assert.deepEqual(result.response, quota());
  assert.equal(JSON.stringify(result).includes('private-sentinel'), false);
  const unavailable = `process.stdout.write('{"id":1,"error":{"message":"private-sentinel"}}\\n'); setInterval(()=>{},100);`;
  await assert.rejects(readQuota({ executable: process.execPath, args: ['-e', unavailable] }), {
    message: 'Account quota unavailable',
  });
  await assert.rejects(
    readQuota({
      executable: process.execPath,
      args: ['-e', 'setInterval(()=>{},100)'],
      timeoutMs: 50,
    }),
    { message: 'Account quota unavailable' },
  );
});
