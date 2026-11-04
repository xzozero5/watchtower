import { afterEach, describe, expect, it, vi } from 'vitest';

import { pushSupported, subscribeThisBrowser, urlBase64ToUint8Array } from './web-push';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('urlBase64ToUint8Array', () => {
  it('decodes unpadded base64url to bytes (the VAPID key format)', () => {
    // 'hello' is aGVsbG8 in base64url without padding.
    expect([...urlBase64ToUint8Array('aGVsbG8')]).toEqual([104, 101, 108, 108, 111]);
    // The URL-safe alphabet: `-` and `_` stand for `+` and `/`.
    expect([...urlBase64ToUint8Array('-_8')]).toEqual([251, 255]);
  });
});

describe('subscribeThisBrowser', () => {
  it('does nothing, and asks for nothing, where Web Push is not available', async () => {
    expect(pushSupported()).toBe(false);
    expect(await subscribeThisBrowser('AAAA')).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('stops at a refused permission without subscribing', async () => {
    const subscribe = vi.fn();
    vi.stubGlobal('PushManager', function PushManager() {});
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: () => Promise.resolve('denied'),
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ pushManager: { subscribe, getSubscription: vi.fn() } }) },
    });
    try {
      expect(await subscribeThisBrowser('AAAA')).toEqual({ ok: false, reason: 'denied' });
      expect(subscribe).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    }
  });

  it('subscribes visibly (userVisibleOnly) with the server key once permission is given', async () => {
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/x' };
    const subscribe = vi.fn(() => Promise.resolve(subscription));
    vi.stubGlobal('PushManager', function PushManager() {});
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: () => Promise.resolve('granted'),
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        ready: Promise.resolve({
          pushManager: { subscribe, getSubscription: () => Promise.resolve(null) },
        }),
      },
    });
    try {
      const result = await subscribeThisBrowser('aGVsbG8');
      expect(result).toEqual({ ok: true, subscription });
      expect(subscribe).toHaveBeenCalledWith({
        userVisibleOnly: true,
        applicationServerKey: new Uint8Array([104, 101, 108, 108, 111]),
      });
    } finally {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    }
  });
});
