'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useShortcut } from '@/lib/keyboard';

export interface StableList<Item> {
  /** What to draw: frozen while the pointer or the keyboard focus is inside the list. */
  shown: readonly Item[];
  /** How many items were added or removed behind the frozen list. */
  changed: number;
  /** Show the latest items now (the pill, or the `.` key). */
  apply: () => void;
  /** Put these on the element that wraps the list. */
  handlers: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onFocus: () => void;
    onBlur: (event: { relatedTarget: EventTarget | null; currentTarget: EventTarget }) => void;
  };
}

/**
 * A list that never reorders under the cursor (PRD section 10, docs/06-UI-SPEC.md section 18.2).
 * While the pointer is over it or focus is inside it, the items stay as they were; when something
 * was added or removed meanwhile, `changed` says how many so the caller can show "N changed —
 * press .". Moving away shows the latest items.
 */
export function useStableList<Item>(
  items: readonly Item[],
  keyOf: (item: Item) => string,
): StableList<Item> {
  const latest = useRef(items);
  useEffect(() => {
    latest.current = items;
  });
  const flags = useRef({ hover: false, focus: false });
  const [frozen, setFrozen] = useState<readonly Item[] | null>(null);

  const update = useCallback(() => {
    const interacting = flags.current.hover || flags.current.focus;
    setFrozen((previous) => (interacting ? (previous ?? latest.current) : null));
  }, []);

  const shown = frozen ?? items;
  let changed = 0;
  if (frozen) {
    const before = new Set(frozen.map(keyOf));
    const after = new Set(items.map(keyOf));
    for (const key of before) if (!after.has(key)) changed += 1;
    for (const key of after) if (!before.has(key)) changed += 1;
  }

  const apply = useCallback(() => {
    setFrozen((previous) => (previous ? latest.current : previous));
  }, []);
  useShortcut('.', apply, changed > 0);

  return {
    shown,
    changed,
    apply,
    handlers: {
      onPointerEnter: () => {
        flags.current.hover = true;
        update();
      },
      onPointerLeave: () => {
        flags.current.hover = false;
        update();
      },
      onFocus: () => {
        flags.current.focus = true;
        update();
      },
      onBlur: (event) => {
        // Focus moving between two things inside the list is not leaving it.
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget instanceof Node) {
          if (event.currentTarget.contains(next)) return;
        }
        flags.current.focus = false;
        update();
      },
    },
  };
}
