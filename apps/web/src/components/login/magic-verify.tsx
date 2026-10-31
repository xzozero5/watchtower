'use client';

import { useMutation } from '@tanstack/react-query';
import { magicLinkVerifySchema } from '@watchtower/shared';
import { Alert, buttonVariants, cn } from '@watchtower/ui';
import { LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { LoginLayout } from '@/components/login/login-layout';
import { useT } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { ApiRequestError, isApiError } from '@/lib/api/errors';

/** The token the emailed link carries in the URL fragment (`#token=...`), or null if missing or malformed. */
export function readMagicToken(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  const parsed = magicLinkVerifySchema.safeParse({ token: value });
  return parsed.success ? parsed.data.token : null;
}

/**
 * Landing page of the emailed sign-in link. The token is in the fragment, so it never reaches a
 * server log or a Referer header; this page reads it, removes it from the address bar, and posts
 * it once. A token works once, so a failure here means "ask for a new link", not "try again".
 */
export function MagicVerify() {
  const t = useT();
  const api = useApi();
  const router = useRouter();
  const started = useRef(false);

  const verify = useMutation({
    mutationFn: (token: string) => {
      // No usable token in the address: fail here, without sending anything.
      if (token === '') {
        return Promise.reject(
          new ApiRequestError(400, 'validation_failed', 'No token in the link'),
        );
      }
      return api.verifyMagicLink(token);
    },
    onSuccess: () => {
      router.replace('/');
    },
  });
  const { mutate } = verify;

  useEffect(() => {
    // React runs effects twice in development; the fragment is gone on the second pass.
    if (started.current) return;
    started.current = true;
    const token = readMagicToken(window.location.hash);
    window.history.replaceState(null, '', window.location.pathname);
    mutate(token ?? '');
  }, [mutate]);

  const failed = verify.isError;
  const rateLimited = isApiError(verify.error) && verify.error.code === 'rate_limited';
  const network = isApiError(verify.error) && verify.error.code === 'network';

  return (
    <LoginLayout>
      <h1 className="text-2xl font-semibold">{t('login.magic.title')}</h1>
      {failed ? (
        <>
          <Alert tone="error" title={t('login.magic.failedTitle')}>
            {rateLimited
              ? t('login.errors.rateLimited')
              : network
                ? t('login.errors.network')
                : t('login.magic.failedBody')}
          </Alert>
          <Link href="/login" className={cn(buttonVariants({ variant: 'primary' }), 'self-start')}>
            {t('login.magic.requestNew')}
          </Link>
        </>
      ) : (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
          {t('login.magic.verifying')}
        </p>
      )}
    </LoginLayout>
  );
}
