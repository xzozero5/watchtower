import { portalMultipartSchema } from '@watchtower/shared';
import type { z } from 'zod';

import { badRequest } from '../auth/http-errors.js';

/**
 * A portal request is the same form whether it arrives as JSON or, when it carries files, as
 * multipart with the JSON in a `payload` field. This returns the form checked against the one
 * schema of the endpoint, so a multipart request cannot slip in anything the JSON one could not.
 */
export function resolvePortalBody<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
): z.output<Schema> {
  const envelope = portalMultipartSchema.safeParse(body);
  let candidate: unknown = body;
  if (envelope.success) {
    try {
      candidate = JSON.parse(envelope.data.payload) as unknown;
    } catch {
      throw badRequest('The payload field is not valid JSON');
    }
  }
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'payload')),
    ];
    throw badRequest(`Invalid request: ${fields.join(', ')}`);
  }
  return parsed.data;
}
