import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { date, execute, read } from './continuation.mjs';

// Account quota only. Never use token_count/context-window events as an account limit.
export function quotaDecision(response, fetchedAt, now = new Date().toISOString()) {
  const unknown = { action: 'blocked', reason: 'quota_unknown' };
  try {
    const age = Date.parse(date(now)) - Date.parse(date(fetchedAt));
    if (age < 0 || age > 60_000) return unknown;
    const bucket = response.rateLimitsByLimitId
      ? response.rateLimitsByLimitId.codex
      : response.rateLimits;
    if (!bucket || (bucket.limitId !== undefined && bucket.limitId !== 'codex')) return unknown;
    if (bucket.rateLimitReachedType != null) return { action: 'blocked', reason: 'quota_reached' };
    const windows = [];
    for (const key of ['primary', 'secondary']) {
      const window = bucket[key];
      // Explicit null is a server-confirmed absent window; omitted data is unknown.
      if (window === null) continue;
      if (
        !window ||
        typeof window.usedPercent !== 'number' ||
        !Number.isFinite(window.usedPercent) ||
        window.usedPercent < 0 ||
        window.usedPercent > 100 ||
        !Number.isSafeInteger(window.windowDurationMins) ||
        window.windowDurationMins <= 0 ||
        !Number.isSafeInteger(window.resetsAt) ||
        window.resetsAt <= 0
      )
        return unknown;
      const resetAt = new Date(window.resetsAt * 1000).toISOString();
      if (resetAt <= now) return unknown;
      windows.push({
        slot: key,
        remainingPercent: 100 - window.usedPercent,
        minutes: window.windowDurationMins,
        resetAt,
      });
    }
    if (!windows.length) return unknown;
    const low = windows.filter((window) => window.remainingPercent <= 5);
    return {
      action: low.length ? 'pause' : 'continue',
      reason: low.length ? 'quota_threshold' : 'quota_available',
      fetchedAt,
      windows,
      nextEligibleAt: low.length
        ? low
            .map((window) => window.resetAt)
            .sort()
            .at(-1)
        : null,
    };
  } catch {
    return unknown;
  }
}

// One read, no LLM turns, credit redemption, login-file reads, or retry loop.
// stdout/stderr from the child are never forwarded: they can contain account metadata.
export async function readQuota({
  executable = 'codex',
  args = ['app-server', '--stdio'],
  timeoutMs = 15_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const lines = createInterface({ input: child.stdout });
    let bytes = 0;
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) finish(true);
    });
    let settled = false;
    function finish(error, response) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.destroy();
      child.kill();
      if (error) reject(new Error('Account quota unavailable'));
      else resolve({ response, fetchedAt: new Date().toISOString() });
    }
    const timer = setTimeout(() => finish(true), timeoutMs);
    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    child.on('error', () => finish(true));
    child.on('exit', () => finish(true));
    child.stdin.on('error', () => finish(true));
    let initialized = false;
    lines.on('line', (line) => {
      if (line.length > 1_000_000) {
        finish(true);
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        finish(true);
        return;
      }
      if (message.id === 1 && !initialized) {
        if (message.error || !message.result) {
          finish(true);
          return;
        }
        initialized = true;
        send({ method: 'initialized' });
        send({ method: 'account/rateLimits/read', id: 2 });
      } else if (message.id === 2 && initialized) {
        finish(Boolean(message.error) || !message.result, message.result);
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'watchtower_quota', version: '0.1.0' } },
    });
  });
}

// Called at safe work boundaries, after HANDOFF/logs have recorded unfinished work.
// A scheduler cannot steal a live claim. Successful reset time alone cannot admit a runner:
// callers must supply a fresh successful read from readQuota every time.
export function synchronizeQuota(
  file,
  decision,
  { task, ownerPid, claimToken } = {},
  now = new Date().toISOString(),
) {
  const previous = read(file);
  if (previous && previous.taskId !== task) throw new Error('Different task owns checkpoint');
  if (previous?.state === 'completed') return previous;
  const claim = claimToken ? { 'claim-token': claimToken } : {};
  if (!['continue', 'pause', 'blocked'].includes(decision.action))
    throw new Error('Invalid quota decision');
  if (decision.action === 'blocked') {
    return execute(file, 'checkpoint', { task, state: 'blocked', ...claim }, now);
  }
  // Reject expired decisions even if the caller retained a formerly good snapshot.
  const age = Date.parse(now) - Date.parse(decision.fetchedAt);
  if (!Number.isFinite(age) || age < 0 || age > 60_000 || !decision.windows?.length) {
    return execute(file, 'checkpoint', { task, state: 'blocked', ...claim }, now);
  }
  const gate = (slot, previousReset) =>
    [
      previousReset ?? now,
      decision.windows.find((window) => window.slot === slot && window.remainingPercent <= 5)
        ?.resetAt ?? now,
    ]
      .sort()
      .at(-1);
  const resets = {
    'five-hour-reset': gate('primary', previous?.fiveHourResetAt),
    'weekly-reset': gate('secondary', previous?.weeklyResetAt),
  };
  if (decision.action === 'pause') {
    if (!previous) execute(file, 'checkpoint', { task, state: 'blocked' }, now);
    return execute(file, 'pause', { ...resets, ...claim }, now);
  }
  if (previous?.state === 'running') {
    // Preserve a live owner's claim. If it died, execute's existing recovery rules apply.
    try {
      process.kill(previous.ownerPid, 0);
    } catch (error) {
      if (error.code !== 'ESRCH') throw new Error('Runner ownership unknown', { cause: error });
      return execute(
        file,
        'checkpoint',
        {
          task,
          state: ownerPid ? 'running' : 'ready',
          ...resets,
          ...claim,
          ...(ownerPid ? { 'owner-pid': String(ownerPid) } : {}),
        },
        now,
      );
    }
    if (Number(ownerPid) !== previous.ownerPid || claimToken !== previous.claimToken)
      throw new Error('Runner already claimed');
    return previous;
  }
  if (Object.values(resets).some((reset) => reset > now)) return previous;
  return execute(
    file,
    'checkpoint',
    {
      task,
      state: ownerPid ? 'running' : 'ready',
      ...resets,
      ...claim,
      ...(ownerPid ? { 'owner-pid': String(ownerPid) } : {}),
    },
    now,
  );
}
