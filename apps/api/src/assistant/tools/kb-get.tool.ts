import { z } from 'zod';

import { forbidden } from '../../auth/http-errors.js';
import {
  cutAtWord,
  toolFact,
  untrusted,
  type ModuleToolContext,
  type ToolRegistrar,
} from './fact-kit.js';

/**
 * `kb_get` (T-405): one knowledge base article with its latest text, as `GET /v1/kb/articles/:id` serves it
 * (`KbService.get`, staff only). The body is text staff wrote and a pasted customer message may be in it: it goes
 * into the fact between `<untrusted_content>` tags, `trust: 'staff'` for the display (C-14). Who wrote it, which
 * organizations it is limited to and its source list are not passed on.
 */
export const kbGetInput = z.strictObject({ id: z.uuid() });

export const kbGetOutput = z.strictObject({
  article: z.strictObject({
    id: z.uuid(),
    slug: z.string().max(200),
    title: z.string().max(300),
    kind: z.string().max(40),
    lang: z.string().max(10),
    status: z.string().max(40),
    version: z.number().int(),
    publishedVersion: z.number().int().nullable(),
    hasUnpublishedChanges: z.boolean(),
    lastVerifiedAt: z.iso.datetime().nullable(),
    bodyMd: z.string().max(6000),
  }),
});
export type KbGetOutput = z.infer<typeof kbGetOutput>;

export function kbGetFacts(output: KbGetOutput) {
  const a = output.article;
  const state =
    a.status === 'published'
      ? `live version ${String(a.publishedVersion ?? a.version)}${a.hasUnpublishedChanges ? ' (a newer edit is not published)' : ''}`
      : `status ${a.status}, not live`;
  const verified = a.lastVerifiedAt === null ? 'never verified' : `verified ${a.lastVerifiedAt}`;
  return [
    toolFact({
      kind: 'kb',
      id: a.id,
      label: a.title,
      // No knowledge base page exists in the web yet: the chip says there is no link (N5).
      text: untrusted(
        a.bodyMd,
        `KB article "${cutAtWord(a.title, 120)}" (${a.lang}, ${state}, ${verified}): `,
      ),
      trust: 'staff',
    }),
  ];
}

export function kbGetTool(ctx: ModuleToolContext): ToolRegistrar {
  return (add) => {
    add(
      'kb_get',
      {
        description: 'Read one knowledge base article by id: its state and its latest text.',
        input: kbGetInput,
        output: kbGetOutput,
        async execute(input) {
          // The route is for staff accounts (`staffOnly`); so is the tool.
          if (ctx.principal.orgScope.kind !== 'all') throw forbidden();
          const found = await ctx.services.kb.get(input.id);
          return {
            article: {
              id: found.id,
              slug: found.slug,
              title: cutAtWord(found.title, 300),
              kind: found.kind,
              lang: found.lang,
              status: found.status,
              version: found.version,
              publishedVersion: found.publishedVersion,
              hasUnpublishedChanges: found.hasUnpublishedChanges,
              lastVerifiedAt: found.lastVerifiedAt,
              bodyMd: cutAtWord(found.bodyMd, 6000),
            },
          };
        },
      },
      '{"id": "uuid of the article"}',
      (output) => kbGetFacts(output),
    );
  };
}
