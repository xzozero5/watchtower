import { randomBytes } from 'node:crypto';

import { DiscordWebhook } from '../webhook.js';

/** Random per call: a test value must never look like (or be) a real credential. */
export function randomWebhookParts(): { id: string; token: string; url: string } {
  const id = `1${randomBytes(6).readUIntBE(0, 6).toString().padStart(16, '0')}`;
  const token = randomBytes(34).toString('base64url');
  return { id, token, url: `https://discord.com/api/webhooks/${id}/${token}` };
}

export function randomWebhook(): DiscordWebhook {
  return DiscordWebhook.parse(randomWebhookParts().url);
}
