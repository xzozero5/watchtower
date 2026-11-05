import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

const states = ['ready', 'running', 'waiting_limit', 'blocked', 'completed'];
const fields = [
  'version',
  'taskId',
  'state',
  'updatedAt',
  'fiveHourResetAt',
  'weeklyResetAt',
  'nextEligibleAt',
  'ownerPid',
  'claimToken',
];

export function date(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    throw new Error('Invalid UTC date');
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z')
  )
    throw new Error('Invalid UTC date');
  return parsed.toISOString();
}

export function validate(record) {
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    Object.keys(record).some((key) => !fields.includes(key))
  )
    throw new Error('Invalid checkpoint');
  if (
    record.version !== 1 ||
    typeof record.taskId !== 'string' ||
    !/^T-\d{3,6}$/.test(record.taskId) ||
    !states.includes(record.state)
  )
    throw new Error('Invalid checkpoint');
  if (date(record.updatedAt) !== record.updatedAt) throw new Error('Noncanonical date');
  const resets = [record.fiveHourResetAt, record.weeklyResetAt];
  for (const reset of resets)
    if (reset !== null && date(reset) !== reset) throw new Error('Noncanonical date');
  const next = resets.every((reset) => reset !== null) ? resets.slice().sort().at(-1) : null;
  if (record.nextEligibleAt !== next || (record.state === 'waiting_limit' && next === null))
    throw new Error('Invalid reset metadata');
  if (record.state === 'running') {
    if (
      !Number.isSafeInteger(record.ownerPid) ||
      record.ownerPid <= 0 ||
      typeof record.claimToken !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(record.claimToken)
    )
      throw new Error('Invalid claim');
  } else if (record.ownerPid !== null || record.claimToken !== null)
    throw new Error('Unexpected claim');
  return record;
}

export function checkpointPath(cwd = process.cwd()) {
  return path.join(
    execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'info'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim(),
    'codex-continuation.json',
  );
}

export function read(file) {
  try {
    return validate(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Checkpoint unreadable or invalid', { cause: error });
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

// A separate exclusive recovery guard serializes dead-owner recovery. Unknown owners fail closed.
export function withLock(file, action) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
  function acquire() {
    fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o600 });
  }
  try {
    acquire();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const recovery = `${lock}.recovery`;
    let guard;
    try {
      guard = fs.openSync(recovery, 'wx', 0o600);
      const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || alive(owner.pid))
        throw new Error('locked', { cause: error });
      fs.unlinkSync(lock);
      acquire();
    } catch (error) {
      throw new Error('Continuation locked; unknown/live owners require manual inspection', {
        cause: error,
      });
    } finally {
      if (guard !== undefined) {
        fs.closeSync(guard);
        fs.unlinkSync(recovery);
      }
    }
  }
  try {
    return action();
  } finally {
    if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock);
  }
}

export function atomicWrite(file, record, rename = fs.renameSync) {
  validate(record);
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    rename(temporary, file);
    // Windows does not support opening directories for fsync.
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(file), 'r');
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function execute(file, command, options = {}, now = new Date().toISOString()) {
  now = date(now);
  if (!['status', 'checkpoint', 'pause', 'complete'].includes(command))
    throw new Error('Unknown command');
  const allowed =
    command === 'checkpoint'
      ? ['task', 'state', 'five-hour-reset', 'weekly-reset', 'owner-pid', 'claim-token']
      : command === 'pause'
        ? ['five-hour-reset', 'weekly-reset', 'claim-token']
        : command === 'complete'
          ? ['claim-token']
          : [];
  if (Object.keys(options).some((key) => !allowed.includes(key))) throw new Error('Unknown option');
  if (command === 'status') return read(file);
  return withLock(file, () => {
    const previous = read(file);
    if (!previous && command !== 'checkpoint') throw new Error('Checkpoint required');
    const taskId = options.task ?? previous?.taskId;
    const sameTask = previous?.taskId === taskId;
    if (
      previous?.state === 'running' &&
      alive(previous.ownerPid) &&
      options['claim-token'] !== previous.claimToken
    )
      throw new Error('Runner already claimed');
    if (previous && !sameTask && previous.state !== 'completed')
      throw new Error('Complete current task first');
    const state =
      command === 'pause'
        ? 'waiting_limit'
        : command === 'complete'
          ? 'completed'
          : (options.state ?? 'ready');
    if (sameTask && previous.state === 'completed' && state !== 'completed')
      throw new Error('Task already completed');
    if (state === 'running' && previous?.state === 'running' && alive(previous.ownerPid))
      throw new Error('Runner already claimed');
    const ownerPid = state === 'running' ? Number(options['owner-pid']) : null;
    if (
      state === 'running' &&
      (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || !alive(ownerPid))
    )
      throw new Error('Live runner PID required');
    const fiveHourResetAt =
      options['five-hour-reset'] === undefined
        ? sameTask
          ? previous.fiveHourResetAt
          : null
        : date(options['five-hour-reset']);
    const weeklyResetAt =
      options['weekly-reset'] === undefined
        ? sameTask
          ? previous.weeklyResetAt
          : null
        : date(options['weekly-reset']);
    // Existing reset gates cannot be shortened by a subsequent checkpoint.
    if (
      sameTask &&
      ((previous.fiveHourResetAt && fiveHourResetAt < previous.fiveHourResetAt) ||
        (previous.weeklyResetAt && weeklyResetAt < previous.weeklyResetAt))
    )
      throw new Error('Reset cannot move earlier');
    const nextEligibleAt =
      fiveHourResetAt && weeklyResetAt ? [fiveHourResetAt, weeklyResetAt].sort().at(-1) : null;
    // Once a quota gate is supplied, both windows must be accounted for. Callers set an
    // available window to now; missing data must never erase a known future reset.
    if (
      ['ready', 'running'].includes(state) &&
      (fiveHourResetAt === null) !== (weeklyResetAt === null)
    )
      throw new Error('Both reset windows required');
    if (['ready', 'running'].includes(state) && nextEligibleAt && now < nextEligibleAt)
      throw new Error('Reset gate pending');
    const record = validate({
      version: 1,
      taskId,
      state,
      updatedAt: date(now),
      fiveHourResetAt,
      weeklyResetAt,
      nextEligibleAt,
      ownerPid,
      claimToken: state === 'running' ? randomUUID() : null,
    });
    atomicWrite(file, record);
    return record;
  });
}
