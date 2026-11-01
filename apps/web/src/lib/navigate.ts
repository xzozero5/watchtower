/**
 * Leaves the app for another address (the OAuth consent page). One function so a test can replace
 * it: assigning `window.location` is not something jsdom allows.
 */
export function navigateTo(url: string): void {
  window.location.assign(url);
}
