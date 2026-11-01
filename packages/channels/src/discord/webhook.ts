import { inspect } from 'node:util';

/**
 * A Discord webhook URL is a bearer secret: whoever holds it can post to the channel (N1). This
 * class is the only way the rest of the code holds one. It
 *
 * - accepts exactly `https://discord.com/api/webhooks/<id>/<token>` (optionally `/api/v<n>/`), so
 *   the only runtime destination is `discord.com` and a URL taken from configuration cannot point
 *   the worker at an internal address (SSRF) or hand the token to another host;
 * - prints as `discord-webhook:<id>` in `String()`, JSON and `util.inspect`, so a log line, an error
 *   or a test snapshot that includes it does not leak the token. The id alone is public (it is also
 *   in the channel's integration list); only the token authorises a post.
 */

export const DISCORD_WEBHOOK_HOST = 'discord.com';

export type DiscordWebhookUrlProblem =
  | 'not_a_url'
  | 'not_https'
  | 'host_not_allowed'
  | 'credentials_in_url'
  | 'port_not_allowed'
  | 'path_not_a_webhook'
  | 'query_not_allowed';

/** Never carries the text it was given: only a code that names the rule that failed. */
export class DiscordWebhookUrlError extends Error {
  readonly reason: DiscordWebhookUrlProblem;

  constructor(reason: DiscordWebhookUrlProblem) {
    super(`not a usable Discord webhook URL (${reason})`);
    this.name = 'DiscordWebhookUrlError';
    this.reason = reason;
  }
}

const PATH = /^\/api(?:\/v\d{1,2})?\/webhooks\/(\d{15,25})\/([A-Za-z0-9._-]{20,200})$/;

export class DiscordWebhook {
  /** The webhook's snowflake id. Not a secret. */
  readonly id: string;
  readonly #token: string;

  private constructor(id: string, token: string) {
    this.id = id;
    this.#token = token;
  }

  /** Throws `DiscordWebhookUrlError` (a rule code only) for anything but a discord.com webhook URL. */
  static parse(value: string): DiscordWebhook {
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new DiscordWebhookUrlError('not_a_url');
    }
    if (url.protocol !== 'https:') throw new DiscordWebhookUrlError('not_https');
    if (url.username !== '' || url.password !== '') {
      throw new DiscordWebhookUrlError('credentials_in_url');
    }
    // `new URL` lower-cases the host and turns look-alike Unicode into punycode, so an exact
    // comparison is enough. A trailing dot, a subdomain or `discordapp.com` all fail here.
    if (url.hostname !== DISCORD_WEBHOOK_HOST) throw new DiscordWebhookUrlError('host_not_allowed');
    // 443 is dropped by the parser; any other port is refused.
    if (url.port !== '') throw new DiscordWebhookUrlError('port_not_allowed');
    if (url.search !== '' || url.hash !== '') throw new DiscordWebhookUrlError('query_not_allowed');
    const match = PATH.exec(url.pathname);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new DiscordWebhookUrlError('path_not_a_webhook');
    }
    return new DiscordWebhook(match[1], match[2]);
  }

  /** Same as `parse`, but `undefined` instead of a throw. */
  static tryParse(value: string): DiscordWebhook | undefined {
    try {
      return DiscordWebhook.parse(value);
    } catch {
      return undefined;
    }
  }

  /**
   * The URL to POST to. Only transports call this. `wait=true` makes Discord answer after the
   * message exists (with its id) instead of 204 right away, so "accepted" means "created".
   */
  executeUrl(): string {
    return `https://${DISCORD_WEBHOOK_HOST}/api/webhooks/${this.id}/${this.#token}?wait=true`;
  }

  toString(): string {
    return `discord-webhook:${this.id}`;
  }

  toJSON(): string {
    return this.toString();
  }

  [inspect.custom](): string {
    return this.toString();
  }
}
