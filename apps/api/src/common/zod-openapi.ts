import type { z } from 'zod';

/**
 * Nest 12 validates request input with a Standard Schema attached to the parameter decorator,
 * and @nestjs/swagger reads the same schema for the OpenAPI document:
 *
 *   @Body({ schema: createThingSchema }) body: CreateThing        // request validation
 *   @ApiOkResponse({ standardSchema: thingSchema })               // documented response
 *
 * One Zod schema per shape is therefore the single source for the type, the validation and the
 * docs. Run the response through `parseResponse` before returning it, so the document and the
 * wire cannot drift apart.
 */
export function parseResponse<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  return schema.parse(value);
}
