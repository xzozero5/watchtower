import { checkpointPath, execute } from './continuation.mjs';

try {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key.startsWith('--') ||
      !value ||
      value.startsWith('--') ||
      Object.hasOwn(options, key.slice(2))
    )
      throw new Error('Invalid arguments');
    options[key.slice(2)] = value;
  }
  console.log(JSON.stringify(execute(checkpointPath(), command, options)));
} catch {
  // Never echo arguments, file contents, or underlying filesystem errors.
  console.error(
    'Continuation command failed: check command/options, reset gates, checkpoint integrity, or lock owner.',
  );
  process.exitCode = 1;
}
