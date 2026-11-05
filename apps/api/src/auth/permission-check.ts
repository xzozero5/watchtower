import type { Permission } from '@watchtower/shared';

/** What a route's decorators ask for: every permission in `all` (RequirePermission), one of `anyOf` (RequireAnyPermission). */
export interface PermissionRequirement {
  readonly all?: readonly Permission[] | undefined;
  readonly anyOf?: readonly Permission[] | undefined;
}

/**
 * The one evaluator of route permissions (T-400 C-1). `AuthGuard` uses it for every request, and the assistant uses it
 * for its tools, so a tool and the GET route it mirrors are decided by the same code on the same data. There is no
 * shortcut by which one permission stands in for another: a developer's `ticket.read.masked` does not satisfy
 * `ticket.read` unless the route itself lists both.
 */
export function satisfiesRequirement(
  held: ReadonlySet<Permission>,
  requirement: PermissionRequirement,
): boolean {
  const missing = requirement.all?.some((permission) => !held.has(permission)) ?? false;
  const anyOk =
    requirement.anyOf === undefined ||
    requirement.anyOf.some((permission) => held.has(permission));
  return !missing && anyOk;
}
