// The LINE Messaging API of the e2e stack (T-113): the in-memory transport of packages/channels with two
// changes the stack needs. The stack's worker is a separate process that receives real webhooks, whose reply
// tokens the fake never issued, so a token is accepted once and for one minute from the first time it is
// seen (the same single-use rule the real API has); and every call is appended to a JSON-lines file so the
// test process can read what the stack "sent" to LINE. Nothing here dials out.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPLY_TOKEN_TTL_MS = 60_000;

export async function createStackLineTransport({ root, logFile }) {
  const channels = await import(
    pathToFileURL(join(root, 'packages', 'channels', 'dist', 'index.js')).href
  );
  const { FakeLineTransport } = channels.line;
  const { ChannelError } = channels;
  const record = (entry) => {
    appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
  };

  class StackLineTransport extends FakeLineTransport {
    #spent = new Set();
    #firstSeen = new Map();

    reply(request) {
      const now = Date.now();
      const first = this.#firstSeen.get(request.replyToken) ?? now;
      this.#firstSeen.set(request.replyToken, first);
      if (this.#spent.has(request.replyToken) || now - first > REPLY_TOKEN_TTL_MS) {
        this.#spent.add(request.replyToken);
        record({ call: 'reply', ok: false, code: 'invalid_reply_token' });
        return Promise.reject(
          new ChannelError({
            provider: 'line',
            operation: 'message.reply',
            kind: 'client',
            status: 400,
            code: 'invalid_reply_token',
          }),
        );
      }
      this.#spent.add(request.replyToken);
      record({
        call: 'reply',
        ok: true,
        texts: request.messages.map((message) => message.text),
      });
      return Promise.resolve({
        requestId: `stack-reply-${String(now)}`,
        sentMessageIds: request.messages.map(
          (_, index) => `stack-r-${String(now)}-${String(index)}`,
        ),
        alreadyAccepted: false,
        acceptedRequestId: null,
      });
    }

    async push(request) {
      const result = await super.push(request);
      record({
        call: 'push',
        ok: true,
        to: request.to,
        texts: request.messages.map((m) => m.text),
      });
      return result;
    }
  }

  return new StackLineTransport({ monthlyLimit: 300 });
}
