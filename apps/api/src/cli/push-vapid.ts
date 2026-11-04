// Makes a VAPID key pair for Web Push and writes it to a file outside the repository (T-105).
//
//   node dist/cli/push-vapid.js --out D:\path\outside\repo\vapid.env
//
// The private key goes to the file only, never to the terminal.
import { PUSH_VAPID_USAGE, runPushVapidCli } from './push-vapid-cli.js';

runPushVapidCli(process.argv.slice(2), {
  out: (line) => {
    console.log(line);
  },
  err: (line) => {
    console.error(line);
  },
}).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    console.error('failed');
    console.error(PUSH_VAPID_USAGE);
    process.exitCode = 1;
  },
);
