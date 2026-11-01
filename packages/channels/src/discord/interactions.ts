import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

import { z } from 'zod';

/**
 * Discord interactions over HTTP (T-202b): signature check, payload shape, response shape. Facts from
 * docs.discord.com (checked 2026-11-02, see README): each request carries `X-Signature-Ed25519` and
 * `X-Signature-Timestamp`; the signature is Ed25519 over the timestamp concatenated with the raw body,
 * checked with the application's public key; a bad signature is answered 401; a PING (type 1) is
 * answered 200 with `{ "type": 1 }`; the initial response is due within 3 seconds; a response is
 * `{ type, data }` with callback types 4 (message), 7 (update the component's message), and the
 * ephemeral flag is 64.
 */

export const INTERACTION_SIGNATURE_HEADER = 'x-signature-ed25519';
export const INTERACTION_TIMESTAMP_HEADER = 'x-signature-timestamp';
/** Discord wants the first answer inside this many milliseconds; the handler's own budget is tested against it. */
export const INTERACTION_DEADLINE_MS = 3000;

/** The 12-byte DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const HEX_KEY = /^[0-9a-f]{64}$/i;
const HEX_SIGNATURE = /^[0-9a-f]{128}$/i;

/** The public key from the 64 hex characters the developer portal shows. Null when it is not one. */
export function publicKeyFromHex(hex: string): KeyObject | null {
  if (!HEX_KEY.test(hex)) return null;
  try {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return null;
  }
}

/**
 * True only when `signatureHex` is a valid Ed25519 signature, by `publicKeyHex`, of `timestamp + rawBody`.
 * Anything malformed (wrong length, not hex, no key) is false, never an exception: the caller answers
 * 401 and learns nothing about which part was wrong.
 */
export function verifyInteractionSignature(input: {
  readonly publicKeyHex: string;
  readonly signatureHex: string | undefined;
  readonly timestamp: string | undefined;
  readonly rawBody: Buffer | undefined;
}): boolean {
  const { signatureHex, timestamp, rawBody } = input;
  if (signatureHex === undefined || timestamp === undefined || rawBody === undefined) return false;
  if (!HEX_SIGNATURE.test(signatureHex) || timestamp.length === 0 || timestamp.length > 40)
    return false;
  const key = publicKeyFromHex(input.publicKeyHex);
  if (key === null) return false;
  try {
    return verify(
      null,
      Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]),
      key,
      Buffer.from(signatureHex, 'hex'),
    );
  } catch {
    return false;
  }
}

/** A key pair for tests: the hex public key Discord would show and a function that signs like Discord. */
export function generateInteractionKeys(): {
  readonly publicKeyHex: string;
  readonly sign: (timestamp: string, rawBody: string | Buffer) => string;
} {
  const pair = generateKeyPairSync('ed25519');
  const jwk = pair.publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('ed25519 public key has no x');
  return {
    publicKeyHex: Buffer.from(jwk.x, 'base64url').toString('hex'),
    sign: (timestamp, rawBody) =>
      sign(
        null,
        Buffer.concat([Buffer.from(timestamp, 'utf8'), Buffer.from(rawBody)]),
        pair.privateKey,
      ).toString('hex'),
  };
}

// --- payloads --------------------------------------------------------------------------------------

export const INTERACTION_TYPES = { ping: 1, command: 2, component: 3 } as const;
export const CALLBACK_TYPES = { pong: 1, message: 4, updateMessage: 7 } as const;
export const EPHEMERAL_FLAG = 64;

const snowflake = z.string().regex(/^[0-9]{5,30}$/);

const commandOptionSchema: z.ZodType<CommandOption> = z.lazy(() =>
  z.object({
    name: z.string().max(64),
    type: z.number().int(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    options: z.array(commandOptionSchema).max(25).optional(),
  }),
);
export interface CommandOption {
  name: string;
  type: number;
  value?: string | number | boolean | undefined;
  options?: CommandOption[] | undefined;
}

/** The part of an interaction Watchtower reads. Unknown fields are ignored, not stored. */
export const interactionSchema = z.object({
  id: snowflake,
  type: z.number().int(),
  application_id: snowflake.optional(),
  token: z.string().max(500).optional(),
  channel_id: snowflake.optional(),
  /** Guild interactions: the person is `member.user`; direct messages: `user`. */
  member: z.object({ user: z.object({ id: snowflake }) }).optional(),
  user: z.object({ id: snowflake }).optional(),
  data: z
    .object({
      custom_id: z.string().max(200).optional(),
      name: z.string().max(64).optional(),
      options: z.array(commandOptionSchema).max(25).optional(),
    })
    .optional(),
});
export type Interaction = z.infer<typeof interactionSchema>;

/** The Discord user id of whoever pressed the button or ran the command. */
export function interactionUserId(interaction: Interaction): string | null {
  return interaction.member?.user.id ?? interaction.user?.id ?? null;
}

export interface InteractionResponse {
  readonly type: number;
  readonly data?: {
    readonly content: string;
    readonly flags?: number;
    readonly components?: unknown[];
    readonly allowed_mentions: { readonly parse: readonly never[] };
  };
}

/** `{ type: 1 }`: the answer to a PING. */
export const PONG: InteractionResponse = { type: CALLBACK_TYPES.pong };

/** A reply only the person who pressed sees. Pings nobody. */
export function ephemeralReply(content: string): InteractionResponse {
  return {
    type: CALLBACK_TYPES.message,
    data: {
      content: content.slice(0, 2000),
      flags: EPHEMERAL_FLAG,
      allowed_mentions: { parse: [] },
    },
  };
}

/** Replaces the message the button was on (for example to take the button away once acknowledged). */
export function updateMessage(content: string, components: unknown[] = []): InteractionResponse {
  return {
    type: CALLBACK_TYPES.updateMessage,
    data: { content: content.slice(0, 2000), components, allowed_mentions: { parse: [] } },
  };
}
