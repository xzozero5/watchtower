import type { Permission } from '@watchtower/shared';

/**
 * What a route's decorator asks for, in the shape of the decorator: `all` = `RequirePermission` (every one),
 * `anyOf` = `RequireAnyPermission` (at least one).
 */
export type PermissionRule =
  { readonly all: readonly Permission[] } | { readonly anyOf: readonly Permission[] };

/**
 * The one evaluator of route permissions (ADR-029 section 2, T-400 C-1). `AuthGuard` uses it for every request, and the
 * assistant uses it for its tools, so a tool and the GET route it mirrors are decided by the same code. There is no
 * shortcut by which one permission stands in for another: a developer's `ticket.read.masked` does not satisfy
 * `ticket.read` unless the rule itself lists both.
 */
export function evaluatePermissionRule(
  holder: { readonly permissions: ReadonlySet<Permission> },
  rule: PermissionRule,
): boolean {
  return 'all' in rule
    ? rule.all.every((permission) => holder.permissions.has(permission))
    : rule.anyOf.some((permission) => holder.permissions.has(permission));
}

/** A route may carry both decorators; both must pass. */
export function evaluatePermissionRules(
  holder: { readonly permissions: ReadonlySet<Permission> },
  rules: readonly PermissionRule[],
): boolean {
  return rules.every((rule) => evaluatePermissionRule(holder, rule));
}
