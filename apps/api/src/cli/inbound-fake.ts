// Puts one fake inbound message into the system for e2e tests and local work (T-122c). Writes an
// `inbound_event` and an `ingest` outbox job, like a real webhook receiver; the worker does the
// rest. Needs DATABASE_URL and a running worker. Never contacts Gmail or LINE.
//
//   node dist/cli/inbound-fake.js gmail --from a@customer.example.test --subject "Cannot sign in" --body "..."
//   node dist/cli/inbound-fake.js gmail --from a@customer.example.test --subject "Re: ..." --body "..." \
//        --thread <gmail thread id> --in-reply-to <message id> [--kind auto_reply|newsletter]
//   node dist/cli/inbound-fake.js line --user U1234 --text "สวัสดีครับ"
//
// Prints one JSON line: { inboundEventId, channelAccountId, providerEventId, duplicate }.
import { createDatabase } from '@watchtower/db';

import { enqueueFakeInbound } from '../inbound/fake-channel.js';
import { FAKE_USAGE, parseFakeInbound } from '../inbound/fake-args.js';

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseFakeInbound(argv);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`DATABASE_URL is not set. ${FAKE_USAGE}`);
    return 2;
  }
  const database = createDatabase({ url, max: 1, applicationName: 'watchtower-inbound-fake-cli' });
  try {
    console.log(JSON.stringify(await enqueueFakeInbound(database, parsed)));
    return 0;
  } catch {
    // The reason can include connection details; the exit code and this line are enough.
    console.error('failed: could not enqueue the fake inbound message');
    return 1;
  } finally {
    await database.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
