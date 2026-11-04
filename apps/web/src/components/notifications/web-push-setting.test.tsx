import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthGate } from '@/components/auth-gate';
import { resetPreferencesCache } from '@/lib/preferences';
import { consoleApi } from '@/test/console-api';
import { renderApp } from '@/test-utils';

import { WebPushSetting } from './web-push-setting';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/home',
}));

interface PushState {
  supported: boolean;
  permission: 'default' | 'granted' | 'denied';
  current: null | { endpoint: string; unsubscribe: () => Promise<boolean> };
  subscribeResult: unknown;
}
const push = vi.hoisted((): PushState => ({
  supported: true,
  permission: 'default',
  current: null,
  subscribeResult: undefined,
}));

vi.mock('@/lib/notifications/web-push', () => ({
  pushSupported: () => push.supported,
  pushPermission: () => push.permission,
  currentPushSubscription: () => Promise.resolve(push.current),
  subscribeThisBrowser: () => Promise.resolve(push.subscribeResult),
  urlBase64ToUint8Array: () => new Uint8Array(),
}));

const KEY = 'B'.repeat(87);
const status = (over: object = {}) => ({
  json: { enabled: true, publicKey: KEY, subscribed: 0, ...over },
});

beforeEach(() => {
  localStorage.clear();
  resetPreferencesCache();
  push.supported = true;
  push.permission = 'default';
  push.current = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(routes: Parameters<typeof consoleApi>[0] = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const api = consoleApi({
    role: 'agent',
    ...routes,
    overrides: {
      'GET /v1/notifications/push': status(),
      'POST /v1/notifications/push/subscriptions': ({ body }) => {
        calls.push({ method: 'POST', path: 'subscriptions', body });
        return status({ subscribed: 1 });
      },
      'DELETE /v1/notifications/push/subscriptions': ({ body }) => {
        calls.push({ method: 'DELETE', path: 'subscriptions', body });
        return status({ subscribed: 0 });
      },
      ...routes.overrides,
    },
  });
  renderApp(
    <AuthGate>
      <WebPushSetting />
    </AuthGate>,
  );
  return { api, calls };
}

describe('the Web Push switch', () => {
  it('is not shown where the browser cannot do Web Push', async () => {
    push.supported = false;
    setup();
    await waitFor(() => {
      expect(screen.queryByTestId('web-push-setting')).toBeNull();
    });
  });

  it('is not shown while the server has Web Push off', async () => {
    setup({
      overrides: { 'GET /v1/notifications/push': status({ enabled: false, publicKey: null }) },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByTestId('web-push-setting')).toBeNull();
  });

  it('asks for permission only when the button is pressed, then saves the subscription', async () => {
    const user = userEvent.setup();
    push.subscribeResult = {
      ok: true,
      subscription: {
        toJSON: () => ({
          endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
          keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
        }),
      },
    };
    const { calls } = setup();
    const button = await screen.findByRole('button', { name: 'Turn on for this device' });
    expect(calls).toHaveLength(0);
    await user.click(button);
    await screen.findByRole('button', { name: 'Turn off for this device' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
    });
  });

  it('says so when the person refuses the permission, and saves nothing', async () => {
    const user = userEvent.setup();
    push.subscribeResult = { ok: false, reason: 'denied' };
    const { calls } = setup();
    await user.click(await screen.findByRole('button', { name: 'Turn on for this device' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission was not given');
    expect(calls).toHaveLength(0);
  });

  it('explains a block in the browser settings instead of offering a button that cannot work', async () => {
    push.permission = 'denied';
    setup();
    expect(await screen.findByText(/blocked for this site/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on for this device' })).toBeNull();
  });

  it('turns off: unsubscribes in the browser and tells the api', async () => {
    const user = userEvent.setup();
    const unsubscribe = vi.fn(() => Promise.resolve(true));
    push.permission = 'granted';
    push.current = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', unsubscribe };
    const { calls } = setup();
    await user.click(await screen.findByRole('button', { name: 'Turn off for this device' }));
    await screen.findByRole('button', { name: 'Turn on for this device' });
    expect(unsubscribe).toHaveBeenCalled();
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' },
    });
  });
});
