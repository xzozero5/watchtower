import { PERMISSION_KEYS, type Permission } from '@watchtower/shared';

import { satisfiesRequirement, type PermissionRequirement } from '../auth/permission-check.js';

/**
 * The parity harness of the assistant tools (ADR-029 section 2, T-400 C-1). A tool may give a person nothing that the
 * GET route it mirrors would refuse them or hide from them. Two checks, both on outcomes and not on names:
 *
 *  1. `authorizationDisagreements`: for a set of permission sets, whenever the tool lets the person in, the route
 *     (decided by the same evaluator as the guard) lets them in too.
 *  2. `leaksBeyondRoute`: every value in the output of the tool is in what the route returns to the same person.
 */

export interface RouteRequirement extends PermissionRequirement {
  readonly key: string;
}

/** A permission only a customer holds. A tool leaves it out; the assistant never serves a customer. */
const CLIENT_ONLY = /\.(org|own)$/;

export interface Disagreement {
  readonly held: readonly Permission[];
  readonly reason: string;
}

/**
 * Permission sets worth trying: every role's defaults, each single permission the tool or the route names, and each
 * of those with `ticket.read.masked` (the developer's read) added or taken away.
 */
export function permissionSetsToTry(
  requirements: readonly PermissionRequirement[],
  roleDefaults: readonly (readonly Permission[])[],
): (readonly Permission[])[] {
  const named = new Set<Permission>();
  for (const requirement of requirements) {
    for (const permission of [...(requirement.all ?? []), ...(requirement.anyOf ?? [])]) {
      named.add(permission);
    }
  }
  const sets: (readonly Permission[])[] = [...roleDefaults, []];
  for (const permission of named) sets.push([permission]);
  // Every permission at once, and everything except one named permission.
  sets.push(PERMISSION_KEYS);
  for (const permission of named) sets.push(PERMISSION_KEYS.filter((other) => other !== permission));
  return sets;
}

/** The sets for which the tool says yes and the route says no. Empty means the tool is no wider than the route. */
export function authorizationDisagreements(
  tool: PermissionRequirement,
  route: PermissionRequirement,
  sets: readonly (readonly Permission[])[],
): Disagreement[] {
  const out: Disagreement[] = [];
  for (const held of sets) {
    const permissions = new Set(held);
    if (satisfiesRequirement(permissions, tool) && !satisfiesRequirement(permissions, route)) {
      out.push({ held, reason: 'the tool lets the person in, the route does not' });
    }
  }
  return out;
}

/** What the tool asks for, less the permissions only a customer holds, must be what the route asks for. */
export function sameAsRoute(tool: PermissionRequirement, route: PermissionRequirement): boolean {
  const withoutClient = (list: readonly Permission[] | undefined) =>
    (list ?? []).filter((permission) => !CLIENT_ONLY.test(permission)).toSorted();
  return (
    JSON.stringify(withoutClient(tool.all)) === JSON.stringify(withoutClient(route.all)) &&
    JSON.stringify(withoutClient(tool.anyOf)) === JSON.stringify(withoutClient(route.anyOf))
  );
}

// --- output within the route's output ----------------------------------------------------------------------

type Scalar = string | number;

function scalarsOf(value: unknown, into: Scalar[] = []): Scalar[] {
  if (typeof value === 'string' || typeof value === 'number') into.push(value);
  else if (Array.isArray(value)) for (const item of value) scalarsOf(item, into);
  else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) scalarsOf(item, into);
  }
  return into;
}

const squash = (text: string): string => text.replaceAll(/\s+/g, ' ').trim();

export interface LeakOptions {
  /**
   * Leaves the tool derived itself (a verdict, a count it computed, a label it wrote): skipped by path, for example
   * `rows.0.overloaded` is matched with `(path) => path.endsWith('.overloaded')`.
   */
  readonly derived?: (path: string) => boolean;
}

/**
 * The paths of the strings and numbers in `toolOutput` that do not appear in `routeOutput`. A string matches when it
 * is equal to a string of the route after whitespace is squashed, is inside one (a message the tool shortened),
 * or ends in `…` and is the start of one. Booleans and null are not data and are skipped.
 */
export function leaksBeyondRoute(
  toolOutput: unknown,
  routeOutput: unknown,
  options: LeakOptions = {},
): string[] {
  const routeScalars = scalarsOf(routeOutput);
  const numbers = new Set(routeScalars.filter((value): value is number => typeof value === 'number'));
  const strings = routeScalars
    .filter((value): value is string => typeof value === 'string')
    .map(squash);
  const leaks: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (options.derived?.(path) === true) return;
    if (typeof value === 'number') {
      // A count the tool derived is a number the route also shows only sometimes; numbers are matched as numbers
      // or as text of the route ("12" inside "OPS-12" is not a match: whole values only).
      if (!numbers.has(value) && !strings.includes(String(value))) leaks.push(path);
    } else if (typeof value === 'string') {
      const text = squash(value);
      const prefix = text.endsWith('…') ? text.slice(0, -1) : null;
      const found = strings.some(
        (candidate) =>
          candidate === text ||
          (text.length >= 3 && candidate.includes(text)) ||
          (prefix !== null && candidate.startsWith(prefix)),
      );
      if (text !== '' && !found) leaks.push(path);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, `${path}.${String(index)}`);
      });
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) walk(item, path === '' ? key : `${path}.${key}`);
    }
  };
  walk(toolOutput, '');
  return leaks;
}
