'use client';

import { Button } from '@watchtower/ui';
import { useEffect, useState } from 'react';

import { useI18n } from '@/i18n/provider';
import { useWebPushMutations, useWebPushStatus } from '@/lib/notifications/queries';
import {
  currentPushSubscription,
  pushPermission,
  pushSupported,
  subscribeThisBrowser,
} from '@/lib/notifications/web-push';

type Problem = 'denied' | 'failed' | null;

/**
 * The Web Push switch of the notification settings (T-105). It shows only when this browser can do Web
 * Push and the server has it set up. Turning it on is the only place the permission prompt is asked for,
 * and only from the click. The message that arrives carries a kind and a link, never a customer's words.
 */
export function WebPushSetting() {
  const { t } = useI18n();
  const supported = pushSupported();
  const status = useWebPushStatus(supported);
  const { subscribe, unsubscribe } = useWebPushMutations();
  const [thisBrowser, setThisBrowser] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void currentPushSubscription().then(
      (subscription) => {
        if (!cancelled) setThisBrowser(subscription !== null);
      },
      () => {
        if (!cancelled) setThisBrowser(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const publicKey = status.data?.publicKey ?? null;
  if (!supported || status.data?.enabled !== true || publicKey === null) return null;

  const turnOn = async () => {
    setProblem(null);
    setBusy(true);
    try {
      const result = await subscribeThisBrowser(publicKey);
      if (!result.ok) {
        setProblem('denied');
        return;
      }
      const json = result.subscription.toJSON();
      const keys = json.keys;
      if (json.endpoint === undefined || keys?.p256dh === undefined || keys.auth === undefined) {
        setProblem('failed');
        return;
      }
      await subscribe.mutateAsync({
        endpoint: json.endpoint,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
        userAgent: navigator.userAgent.slice(0, 300),
      });
      setThisBrowser(true);
    } catch {
      setProblem('failed');
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setProblem(null);
    setBusy(true);
    try {
      const subscription = await currentPushSubscription();
      if (subscription !== null) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        await unsubscribe.mutateAsync(endpoint);
      }
      setThisBrowser(false);
    } catch {
      setProblem('failed');
    } finally {
      setBusy(false);
    }
  };

  const blocked = pushPermission() === 'denied' && thisBrowser !== true;
  return (
    <div className="mt-3 border-t border-border pt-2.5" data-testid="web-push-setting">
      <h4 className="text-sm font-medium">{t('notifications.push.title')}</h4>
      <p className="mt-0.5 text-xs text-muted-foreground">{t('notifications.push.hint')}</p>
      {blocked ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{t('notifications.push.blocked')}</p>
      ) : (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-1.5"
          disabled={busy || thisBrowser === null}
          onClick={() => {
            void (thisBrowser === true ? turnOff() : turnOn());
          }}
        >
          {thisBrowser === true ? t('notifications.push.turnOff') : t('notifications.push.turnOn')}
        </Button>
      )}
      {problem !== null ? (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {problem === 'denied' ? t('notifications.push.denied') : t('notifications.push.failed')}
        </p>
      ) : null}
    </div>
  );
}
