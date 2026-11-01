import { z } from 'zod';

import { ChannelError } from '../common/errors.js';

/**
 * The Discord bot (T-202b): posting with buttons, threads, editing a message. Interactions (what comes
 * back when someone presses a button) are in `./interactions.ts`. `BotTransport` is the seam: the fake
 * in `./bot-fake.ts` is the only implementation in Phase 2 (no token, no network); a live one is a
 * later task behind `[ASK-HUMAN]`, and `bot.contract.ts`-style tests will then run against both.
 *
 * Limits are from the developer documentation (docs.discord.com, checked 2026-11-02, see README):
 * a message has at most 2,000 characters of content; an action row holds at most 5 buttons; a button
 * label is at most 80 characters and its `custom_id` 1 to 100; a thread name is 1 to 100 characters.
 *
 * Mentions are never parsed from content: every message carries `allowed_mentions` naming exactly the
 * people it may ping, which are Discord user ids that a staff member linked to their own account.
 */

export const BOT_MAX_CONTENT = 2000;
export const BOT_MAX_BUTTONS = 5;
export const BOT_MAX_LABEL = 80;
export const BOT_MAX_CUSTOM_ID = 100;
export const BOT_MAX_THREAD_NAME = 100;

/** Discord's button styles that carry a `custom_id` (numbers 1 to 4); link buttons are not used here. */
export const BOT_BUTTON_STYLES = { primary: 1, secondary: 2, success: 3, danger: 4 } as const;

export const botButtonSchema = z.object({
  customId: z.string().min(1).max(BOT_MAX_CUSTOM_ID),
  label: z.string().min(1).max(BOT_MAX_LABEL),
  style: z.enum(['primary', 'secondary', 'success', 'danger']),
});
export type BotButton = z.infer<typeof botButtonSchema>;

export const botMessageSchema = z.strictObject({
  content: z.string().min(1).max(BOT_MAX_CONTENT),
  buttons: z.array(botButtonSchema).max(BOT_MAX_BUTTONS).default([]),
  /** Discord user ids this message may ping. Everything else in the content is inert. */
  mentionUserIds: z
    .array(z.string().regex(/^[0-9]{5,30}$/))
    .max(20)
    .default([]),
});
export type BotMessage = z.input<typeof botMessageSchema>;
export type ParsedBotMessage = z.output<typeof botMessageSchema>;

export interface BotSendResult {
  /** True only when Discord accepted the message and created it. A fake always says false. */
  readonly delivered: boolean;
  readonly channelId: string | null;
  readonly messageId: string | null;
}

export interface BotThreadResult {
  readonly delivered: boolean;
  readonly channelId: string | null;
  readonly threadId: string | null;
}

export interface BotTransport {
  /** `live` reaches discord.com; `fake` never leaves the process. */
  readonly kind: 'live' | 'fake';
  /**
   * Posts a message with buttons to a channel. Rejects with a `ChannelError` (provider `discord`):
   * `rate_limited` with `retryAfterMs` when nothing was posted; `timeout`, `network`, `server` when
   * the outcome is unknown; `auth`, `not_found`, `client` when it will not work as it is.
   */
  postMessage(channelId: string, message: BotMessage): Promise<BotSendResult>;
  /** Replaces the content and buttons of a message the bot posted (for example to take the button away). */
  editMessage(
    channelId: string,
    messageId: string,
    message: BotMessage,
  ): Promise<{ delivered: boolean }>;
  /** Starts a public thread on a message (the incident thread, R-3.13). */
  createThread(channelId: string, messageId: string, name: string): Promise<BotThreadResult>;
  /** Posts into a thread. */
  postInThread(threadId: string, message: BotMessage): Promise<BotSendResult>;
}

/** The wire form of a message's components: one action row of up to 5 buttons (type 1 holding type 2). */
export function toDiscordComponents(message: ParsedBotMessage): unknown[] {
  if (message.buttons.length === 0) return [];
  return [
    {
      type: 1,
      components: message.buttons.map((button) => ({
        type: 2,
        style: BOT_BUTTON_STYLES[button.style],
        label: button.label,
        custom_id: button.customId,
      })),
    },
  ];
}

/** The JSON body of Create Message / Edit Message. `allowed_mentions.parse` is empty: only listed users can be pinged. */
export function toDiscordPayload(message: ParsedBotMessage): Record<string, unknown> {
  return {
    content: message.content,
    components: toDiscordComponents(message),
    allowed_mentions: { parse: [], users: message.mentionUserIds },
  };
}

export function parseBotMessage(message: BotMessage): ParsedBotMessage {
  const parsed = botMessageSchema.safeParse(message);
  if (!parsed.success) {
    throw new ChannelError({
      provider: 'discord',
      operation: 'message.validate',
      kind: 'client',
      code: 'invalid_message',
    });
  }
  return parsed.data;
}

/** A thread name Discord accepts: no line breaks, trimmed, at most 100 characters. */
export function threadName(text: string): string {
  const flat = text.replace(/[\r\n]+/g, ' ').trim();
  return (flat.length === 0 ? 'incident' : flat).slice(0, BOT_MAX_THREAD_NAME);
}
