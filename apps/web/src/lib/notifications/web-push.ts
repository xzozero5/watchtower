/**
 * Browser side of Web Push (T-105). Nothing here runs unless the person presses the switch: the
 * permission prompt is asked for on that click only, never on load. The subscription goes to our api
 * with the VAPID public key the api gave; the endpoint stays between the browser and the api.
 */

/** True when this browser can do Web Push at all (service worker, Push API, Notification API). */
export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** `applicationServerKey` wants bytes; the api sends the key as base64url. */
export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export type PushPermission = 'default' | 'granted' | 'denied';

export function pushPermission(): PushPermission {
  return pushSupported() ? Notification.permission : 'denied';
}

/** This browser's own subscription, or null. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

export type EnableResult =
  | { readonly ok: true; readonly subscription: PushSubscription }
  | { readonly ok: false; readonly reason: 'denied' | 'unsupported' };

/**
 * Asks for permission (call this from the click itself) and subscribes with `userVisibleOnly`, the
 * only mode browsers allow: every message must show a notification.
 */
export async function subscribeThisBrowser(publicKey: string): Promise<EnableResult> {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' };
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));
  return { ok: true, subscription };
}
