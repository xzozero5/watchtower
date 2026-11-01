/**
 * The undo window of an approved reply (docs/06-UI-SPEC.md sections 5.3 and 6.3, Q1 `[ASSUMED]`
 * 5 s): after "Approve and send" the reply waits a few seconds and a person can still take it
 * back. The spec wants the hold on the server (scheduled send that Undo cancels); the api has no
 * such endpoint yet, so until it does the web holds the call itself. A closed tab inside the
 * window therefore sends nothing, which is the safe way to fail.
 *
 * This is not auto-send (N3): a person read the preview and pressed Approve; the window only
 * gives them a last chance.
 */
export const UNDO_WINDOW_MS = 5000;

const inFlight = new Set<string>();

/** True from the moment a draft is scheduled until its send finished or was undone. */
export function isScheduled(draftId: string): boolean {
  return inFlight.has(draftId);
}

export interface ScheduledSend {
  /** Takes the reply back. No effect once the window has passed. */
  cancel: () => void;
}

/**
 * Runs `send` after the undo window. `done` tells the module the call finished (success or
 * failure), which allows the same draft to be scheduled again. The timer lives outside React on
 * purpose: moving to another ticket during the window must not cancel an approved reply.
 */
export function scheduleSend(
  draftId: string,
  send: (done: () => void) => void,
  windowMs: number = UNDO_WINDOW_MS,
): ScheduledSend {
  inFlight.add(draftId);
  let cancelled = false;
  const timer = setTimeout(() => {
    if (cancelled) return;
    send(() => {
      inFlight.delete(draftId);
    });
  }, windowMs);
  return {
    cancel: () => {
      cancelled = true;
      clearTimeout(timer);
      inFlight.delete(draftId);
    },
  };
}
