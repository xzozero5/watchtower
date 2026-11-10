import { checkpointPath } from './continuation.mjs';
import { quotaDecision, readQuota, synchronizeQuota } from './quota.mjs';

try {
  const [command, ...args] = process.argv.slice(2);
  if (!['check', 'sync'].includes(command)) throw new Error('Invalid command');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--task', '--owner-pid'].includes(key) || !value || Object.hasOwn(options, key))
      throw new Error('Invalid option');
    options[key] = value;
  }
  if (command === 'check' && args.length) throw new Error('Invalid option');
  let decision;
  try {
    const { response, fetchedAt } = await readQuota();
    decision = quotaDecision(response, fetchedAt);
  } catch {
    decision = { action: 'blocked', reason: 'quota_unknown' };
  }
  let checkpoint;
  if (command === 'sync') {
    if (!/^T-\d{3,6}$/.test(options['--task'] ?? '')) throw new Error('Task required');
    checkpoint = synchronizeQuota(checkpointPath(), decision, {
      task: options['--task'],
      ownerPid: options['--owner-pid'],
      claimToken: process.env.WT_CONTINUATION_CLAIM_TOKEN,
    });
  }
  // Never print claim tokens, account ids, email, credits or raw protocol responses.
  const admitted = Boolean(
    command === 'sync' &&
    options['--owner-pid'] &&
    decision.action === 'continue' &&
    checkpoint?.state === 'running',
  );
  console.log(
    JSON.stringify({
      ...decision,
      ...(command === 'sync' ? { admitted } : {}),
      ...(checkpoint
        ? {
            checkpoint: {
              taskId: checkpoint.taskId,
              state: checkpoint.state,
              nextEligibleAt: checkpoint.nextEligibleAt,
            },
          }
        : {}),
    }),
  );
  if (
    decision.action !== 'continue' ||
    (command === 'sync' && !admitted && checkpoint?.state !== 'completed')
  )
    process.exitCode = 2;
} catch {
  console.error(
    'Quota check failed: inspect checkpoint ownership, task and local Codex availability.',
  );
  process.exitCode = 1;
}
