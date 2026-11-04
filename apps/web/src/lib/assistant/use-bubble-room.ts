'use client';

import { useEffect, useState } from 'react';

/** Marks the assistant's own sheet, so it is not counted as "another dialog is open". */
export const ASSISTANT_SURFACE_ATTRIBUTE = 'data-assistant-surface';
/** Marks a bar that sits at the foot of the window and must stay reachable (composer, draft actions). */
export const STICKY_FOOTER_SELECTOR = '[data-sticky-footer]';

const MODAL_SELECTOR = `[role="dialog"][data-state="open"]:not([${ASSISTANT_SURFACE_ATTRIBUTE}]), [role="alertdialog"]`;
/** How far from the right edge and the bottom the button reaches (its size plus its margin), in px. */
const BUTTON_ZONE = 88;
const GAP = 8;
/** Never lift the button above this share of the window; past that it would be in the way itself. */
const MAX_LIFT_SHARE = 0.4;

export interface BubbleRoom {
  /** A dialog (not the assistant's own) is open: the button gets out of the way. */
  modalOpen: boolean;
  /** Extra px above the button's resting place so it clears a bar at the foot of the window. */
  lift: number;
}

/** Pure part of the measurement, so it can be tested without a layout engine. */
export function liftFor(
  rects: readonly { top: number; right: number; bottom: number; height: number }[],
  viewport: { width: number; height: number },
): number {
  let lift = 0;
  for (const rect of rects) {
    if (rect.height <= 0) continue;
    const reachesRight = rect.right > viewport.width - BUTTON_ZONE;
    const reachesBottom = rect.bottom > viewport.height - BUTTON_ZONE && rect.top < viewport.height;
    if (reachesRight && reachesBottom) lift = Math.max(lift, viewport.height - rect.top + GAP);
  }
  return Math.min(lift, Math.round(viewport.height * MAX_LIFT_SHARE));
}

/**
 * Watches the page for what the floating button must not cover or sit on top of: a bar at the foot
 * of the window (the composer, the draft actions, which may be sticky) and an open dialog. Cheap:
 * one measurement per animation frame, and state changes only when a value does.
 */
export function useBubbleRoom(): BubbleRoom {
  const [room, setRoom] = useState<BubbleRoom>({ modalOpen: false, lift: 0 });

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const modalOpen = document.querySelector(MODAL_SELECTOR) !== null;
      const rects = [...document.querySelectorAll(STICKY_FOOTER_SELECTOR)].map((element) =>
        element.getBoundingClientRect(),
      );
      const lift = liftFor(rects, { width: window.innerWidth, height: window.innerHeight });
      setRoom((current) =>
        current.modalOpen === modalOpen && current.lift === lift ? current : { modalOpen, lift },
      );
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-state', 'hidden', 'class', 'style'],
    });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, []);

  return room;
}
