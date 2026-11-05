import type { AssistantFact } from '@watchtower/ai';
import {
  statusComponentStatusSchema,
  statusPostImpactSchema,
  statusPostListQuerySchema,
  statusPostPhaseSchema,
} from '@watchtower/shared';
import { z } from 'zod';

import type { StatusAdminService } from '../../statuspage/status-admin.service.js';
import { cut, limitSchema, makeFact, type OpsToolKit } from './ops-tool-kit.js';

/**
 * `statuspage_status` and `statuspage_drafts` (T-402, ADR-029 section 2). Both read through `StatusAdminService`, which the
 * staff routes under `/v1/status-page` call (components, posts and maintenance windows), and need `ticket.read` whole,
 * like those routes (the masked developer is not let in: C-1). Nothing here publishes: a draft is read, never sent (N3).
 * The wording of a post and the title of a window are written by staff: untrusted content (C-14).
 */

export interface StatuspageToolDeps {
  readonly statusAdmin: StatusAdminService;
}

export const statuspageStatusInput = z.strictObject({});
export const statuspageStatusOutput = z.object({
  components: z
    .array(
      z.object({
        id: z.uuid(),
        name: z.string().max(200),
        status: statusComponentStatusSchema,
        public: z.boolean(),
      }),
    )
    .max(50),
  maintenance: z
    .array(
      z.object({
        id: z.uuid(),
        title: z.string().max(200),
        startsAt: z.string().max(40),
        endsAt: z.string().max(40),
      }),
    )
    .max(10),
});

export const statuspageDraftsInput = z.strictObject({ limit: limitSchema });
export const statuspageDraftsOutput = z.object({
  posts: z
    .array(
      z.object({
        id: z.uuid(),
        title: z.string().max(200),
        body: z.string().max(1000),
        phase: statusPostPhaseSchema,
        impact: statusPostImpactSchema,
        origin: z.enum(['human', 'ai']),
        incidentId: z.uuid().nullable(),
        updatedAt: z.string().max(40),
      }),
    )
    .max(20),
  maintenance: z
    .array(
      z.object({
        id: z.uuid(),
        title: z.string().max(200),
        body: z.string().max(1000),
        origin: z.enum(['human', 'ai']),
        startsAt: z.string().max(40),
        endsAt: z.string().max(40),
      }),
    )
    .max(20),
});

export function registerStatuspageTools(deps: StatuspageToolDeps, kit: OpsToolKit): void {
  kit.add(
    'statuspage_status',
    {
      description:
        'The state of each status page component (operational, degraded, outage) and the published maintenance windows that have not ended.',
      input: statuspageStatusInput,
      output: statuspageStatusOutput,
      async execute() {
        const [components, windows] = await Promise.all([
          deps.statusAdmin.listComponents(),
          deps.statusAdmin.listMaintenance(),
        ]);
        return {
          components: components.slice(0, 50).map((component) => ({
            id: component.id,
            name: cut(component.name, 200),
            status: component.status,
            public: component.public,
          })),
          maintenance: windows
            .filter(
              (window) =>
                window.state === 'published' && Date.parse(window.endsAt) > kit.now.getTime(),
            )
            .slice(0, 10)
            .map((window) => ({
              id: window.id,
              title: cut(window.title, 200),
              startsAt: window.startsAt,
              endsAt: window.endsAt,
            })),
        };
      },
    },
    '{}',
    (output) => {
      const facts: AssistantFact[] = [];
      const byStatus = new Map<string, number>();
      for (const component of output.components) {
        byStatus.set(component.status, (byStatus.get(component.status) ?? 0) + 1);
      }
      const first = output.components[0];
      if (first !== undefined) {
        facts.push(
          makeFact({
            kind: 'statuspage',
            id: first.id,
            label: 'Status page',
            system: `Status page components: ${[...byStatus].map(([status, n]) => `${String(n)} ${status}`).join(', ')}.`,
          }),
        );
      }
      // The components that are not fine get a fact each, so the model can cite them.
      for (const component of output.components
        .filter((item) => item.status !== 'operational')
        .slice(0, 10)) {
        facts.push(
          makeFact({
            kind: 'statuspage',
            id: component.id,
            label: cut(component.name, 80),
            system: `Component is ${component.status}${component.public ? '' : ' (not public)'}. Name:`,
            free: [component.name],
          }),
        );
      }
      for (const window of output.maintenance) {
        facts.push(
          makeFact({
            kind: 'statuspage',
            id: window.id,
            label: cut(window.title, 80),
            system: `Maintenance window published, ${window.startsAt} to ${window.endsAt}. Title:`,
            free: [window.title],
          }),
        );
      }
      return facts;
    },
  );

  kit.add(
    'statuspage_drafts',
    {
      description:
        'The status page posts and maintenance windows that are drafts, waiting for a person to publish them. Reading a draft never publishes it.',
      input: statuspageDraftsInput,
      output: statuspageDraftsOutput,
      async execute(input) {
        const [posts, windows] = await Promise.all([
          deps.statusAdmin.listPosts(
            statusPostListQuerySchema.parse({ state: 'draft', limit: input.limit }),
          ),
          deps.statusAdmin.listMaintenance(),
        ]);
        // `limit` is for the two kinds together (at most 30 facts a turn): the posts first, the windows with what is left.
        const postRows = posts.items.slice(0, input.limit);
        return {
          posts: postRows.map((post) => ({
            id: post.id,
            title: cut(post.title, 200),
            body: cut(post.body, 1000),
            phase: post.phase,
            impact: post.impact,
            origin: post.origin,
            incidentId: post.incidentId,
            updatedAt: post.updatedAt,
          })),
          maintenance: windows
            .filter((window) => window.state === 'draft')
            .slice(0, input.limit - postRows.length)
            .map((window) => ({
              id: window.id,
              title: cut(window.title, 200),
              body: cut(window.body, 1000),
              origin: window.origin,
              startsAt: window.startsAt,
              endsAt: window.endsAt,
            })),
        };
      },
    },
    '{"limit"?: 10}',
    (output) => [
      ...output.posts.map((post) =>
        makeFact({
          kind: 'statuspage',
          id: post.id,
          label: cut(post.title, 80),
          system: `Draft post (${post.origin}), ${post.phase}, impact ${post.impact}${
            post.incidentId === null ? '' : `, for incident ${post.incidentId}`
          }, updated ${post.updatedAt}. Not published. Text:`,
          free: [post.title, post.body],
        }),
      ),
      ...output.maintenance.map((window) =>
        makeFact({
          kind: 'statuspage',
          id: window.id,
          label: cut(window.title, 80),
          system: `Draft maintenance window (${window.origin}), ${window.startsAt} to ${window.endsAt}. Not published. Text:`,
          free: [window.title, window.body],
        }),
      ),
    ],
  );
}
