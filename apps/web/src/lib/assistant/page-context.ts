'use client';

import type {
  AssistantContext,
  AssistantElement,
  AssistantEntity,
  AssistantPage,
  AssistantSelection,
} from '@watchtower/shared';
import { useEffect, useState } from 'react';

import { resolveLocation } from './page-registry';

export interface PageContext {
  element?: AssistantElement | null;
  page: AssistantPage;
  /** The thing open on the page, or the one an "Ask AI about this" button pinned. */
  entity: AssistantEntity | null;
  /** Chips picked on a list (several things at once). Null when none. */
  selection: AssistantSelection | null;
  /** A name for the chip, from the button that pinned it. Display only, never sent. */
  label: string | null;
  /** Which press of an "Ask AI" button pinned it (0: none). */
  pin: number;
}

/** What the person asked about from a row or a card ("Ask AI about this"). */
export interface AskTarget {
  element?: AssistantElement;
  entity?: AssistantEntity;
  selection?: AssistantSelection;
  label?: string;
  /** Set by the bubble: a new press on the same button is a new chip, even if it was removed before. */
  pin?: number;
}

export interface RemovedChips {
  element?: boolean;
  page: boolean;
  entity: boolean;
  selection: boolean;
}

export const NONE_REMOVED: RemovedChips = { page: false, entity: false, selection: false };

/** A key that changes when the place or the thing changes: a chip removed stays removed only for it. */
export function contextKey(context: PageContext): string {
  const entity = context.entity ? `${context.entity.kind}:${context.entity.ref}` : '';
  const selection = context.selection
    ? `${context.selection.kind}:${context.selection.refs.join(',')}`
    : '';
  return `${JSON.stringify(context.element ?? null)}|${context.page}|${entity}|${selection}|${String(context.pin)}`;
}

const POLL_MS = 600;

/**
 * What the chips above the input say, kept up to date. The queue keeps the open ticket in the
 * address with `replaceState`, which fires no event, so while the panel is open the address is read
 * again every so often. `pinned` is what an "Ask AI about this" button chose; it wins over the
 * address until the person goes elsewhere. No hidden context: the chips are exactly what is sent
 * (the person can remove each).
 */
export function usePageContext(
  pathname: string,
  active: boolean,
  pinned: AskTarget | null = null,
): PageContext {
  const read = (): PageContext => {
    const here = resolveLocation(pathname, window.location.search);
    return {
      page: here.page,
      element: pinned?.element ?? null,
      entity: pinned?.element ? (pinned.entity ?? null) : (pinned?.entity ?? here.entity),
      selection: pinned?.selection ?? null,
      label: pinned?.entity || pinned?.element ? (pinned.label ?? null) : null,
      pin: pinned?.pin ?? 0,
    };
  };
  const [context, setContext] = useState<PageContext>(read);

  useEffect(() => {
    const update = () => {
      const next = read();
      setContext((current) =>
        contextKey(current) === contextKey(next) && current.label === next.label ? current : next,
      );
    };
    update();
    if (!active) return undefined;
    const timer = window.setInterval(update, POLL_MS);
    window.addEventListener('popstate', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('popstate', update);
    };
    // `read` closes over `pathname` and `pinned` only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, active, pinned]);

  return context;
}

/** The request context for the chips that are still on. */
export function contextForRequest(
  context: PageContext,
  removed: RemovedChips,
): AssistantContext | undefined {
  const result: AssistantContext = {};
  if (!removed.page) result.page = context.page;
  if (!removed.element && context.element) result.element = context.element;
  if (!removed.entity && context.entity !== null) {
    result.entity = context.entity;
    // The first release read `ticket`; an older server still does.
    if (context.entity.kind === 'ticket') result.ticket = context.entity.ref;
  }
  if (!removed.selection && context.selection !== null) result.selection = context.selection;
  return Object.keys(result).length === 0 ? undefined : result;
}
