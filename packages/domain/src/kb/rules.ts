import type { KbStatus, KbVisibility } from '@watchtower/shared';

/** Who may see an article: its visibility and, for `orgs`, the organizations. */
export interface KbAudienceSpec {
  readonly visibility: KbVisibility;
  readonly orgIds: readonly string[];
}

/**
 * True when `after` lets someone see the article who could not see it under `before`. Making an
 * article visible to more people is the decision of an approver (`kb.approve`); narrowing it, for
 * example pulling an article back to internal, is safe and anyone who may edit can do it.
 */
export function audienceWidens(before: KbAudienceSpec, after: KbAudienceSpec): boolean {
  if (before.visibility === 'customer') return false;
  if (after.visibility === 'internal') return false;
  if (before.visibility === 'internal') return true;
  // before is `orgs`
  if (after.visibility === 'customer') return true;
  const had = new Set(before.orgIds);
  return after.orgIds.some((orgId) => !had.has(orgId));
}

/**
 * The status moves a person can ask for without publishing (publishing is its own operation
 * because it also names the version that goes live):
 *   draft -> in_review, in_review -> draft (withdraw or send back),
 *   draft | in_review | published -> deprecated, deprecated -> draft (start over from the last text).
 */
const MOVES: Readonly<Record<KbStatus, readonly KbStatus[]>> = {
  draft: ['in_review', 'deprecated'],
  in_review: ['draft', 'deprecated'],
  published: ['deprecated'],
  deprecated: ['draft'],
};

export function canMove(from: KbStatus, to: KbStatus): boolean {
  return MOVES[from].includes(to);
}

/** Statuses an article can be published from. A deprecated one first goes back to draft. */
export function canPublishFrom(status: KbStatus): boolean {
  return status !== 'deprecated';
}

/** The same readers: the same visibility and, for `orgs`, the same organizations. */
export function sameAudience(a: KbAudienceSpec, b: KbAudienceSpec): boolean {
  if (a.visibility !== b.visibility) return false;
  if (a.visibility !== 'orgs') return true;
  const left = [...new Set(a.orgIds)].sort();
  const right = [...new Set(b.orgIds)].sort();
  return left.length === right.length && left.every((id, at) => id === right[at]);
}
