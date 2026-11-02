'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { WORKSPACE_ROLES, type AuthConfig, type WorkspaceRole } from '@watchtower/shared';
import {
  Alert,
  Button,
  buttonVariants,
  cn,
  Input,
  Select,
  Skeleton,
  TINT_CLASSES,
  TintChip,
  type TintId,
} from '@watchtower/ui';
import { BadgeCheck, KeyRound, LogIn, type LucideIcon, Mail, Wrench } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { type SyntheticEvent, type ReactNode, useEffect, useId, useState } from 'react';

import { LoginLayout } from '@/components/login/login-layout';
import { useI18n } from '@/i18n/provider';
import type { MessageKey } from '@/i18n';
import { useApi } from '@/lib/api/api-context';
import { isApiError } from '@/lib/api/errors';
import { parseSsoError, type SsoFailure, SSO_PROVIDER, ssoStartUrl } from '@/lib/auth/providers';
import { useSession } from '@/lib/auth/session';
import { useRuntimeConfig } from '@/lib/runtime-config-context';

const SSO_ERROR_KEYS: Record<SsoFailure, MessageKey> = {
  stateInvalid: 'login.sso.errors.stateInvalid',
  denied: 'login.sso.errors.denied',
  unavailable: 'login.sso.errors.unavailable',
  emailNotVerified: 'login.sso.errors.emailNotVerified',
  domainNotAllowed: 'login.sso.errors.domainNotAllowed',
  notProvisioned: 'login.sso.errors.notProvisioned',
  accountDisabled: 'login.sso.errors.accountDisabled',
  accountMismatch: 'login.sso.errors.accountMismatch',
  unknown: 'login.sso.errors.unknown',
};

/** One way in, as a soft rounded card with an icon bubble beside its title. */
function Section({
  title,
  badge,
  icon: Icon,
  tone,
  children,
}: {
  title: string;
  /** A short chip after the title (`Dev`): what the sentence under it used to say. */
  badge?: string;
  icon: LucideIcon;
  tone: TintId;
  children: ReactNode;
}) {
  const id = useId();
  const { t } = useI18n();
  return (
    <section
      aria-labelledby={id}
      className="rounded-2xl bg-surface p-5 ring-1 ring-border/60 ring-inset"
    >
      <div className="flex items-center gap-2.5">
        <h2 id={id} className="flex items-center gap-2.5 text-base font-semibold">
          <span
            aria-hidden
            className={cn(
              'inline-flex size-8 shrink-0 items-center justify-center rounded-full',
              TINT_CLASSES[tone].chip,
              TINT_CLASSES[tone].icon,
            )}
          >
            <Icon className="size-4" />
          </span>
          {title}
        </h2>
        {badge ? (
          <TintChip tone="amber" title={t('login.dev.description')}>
            {badge}
          </TintChip>
        ) : null}
      </div>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

function StaffSso({ config }: { config: AuthConfig }) {
  const { t } = useI18n();
  const { apiUrl } = useRuntimeConfig();
  const href = ssoStartUrl(apiUrl, config);
  return (
    <Section title={t('login.staff.title')} icon={BadgeCheck} tone="blue">
      {href ? (
        <a
          href={href}
          className={cn(buttonVariants({ variant: 'primary' }), 'w-full rounded-full')}
        >
          <LogIn aria-hidden className="size-4" />
          {t('login.sso.button', { provider: SSO_PROVIDER.displayName })}
        </a>
      ) : (
        <>
          <Button variant="primary" className="w-full rounded-full" disabled>
            <LogIn aria-hidden className="size-4" />
            {t('login.sso.button', { provider: SSO_PROVIDER.displayName })}
          </Button>
          <p className="text-sm text-muted-foreground">
            {t('login.sso.notConfigured', { provider: SSO_PROVIDER.displayName })}
          </p>
        </>
      )}
    </Section>
  );
}

function DevLogin({ onSignedIn }: { onSignedIn: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const ids = useId();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<WorkspaceRole>('agent');
  const mutation = useMutation({
    mutationFn: () => api.devLogin({ email, role }),
    onSuccess: onSignedIn,
  });
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    mutation.mutate();
  };
  return (
    <Section title={t('login.dev.title')} badge={t('login.dev.badge')} icon={Wrench} tone="amber">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label={t('login.email')} htmlFor={`${ids}-email`}>
          <Input
            id={`${ids}-email`}
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </Field>
        <Field label={t('login.dev.role')} htmlFor={`${ids}-role`}>
          <Select
            id={`${ids}-role`}
            value={role}
            onChange={(event) => {
              const next = WORKSPACE_ROLES.find((value) => value === event.target.value);
              if (next) setRole(next);
            }}
          >
            {WORKSPACE_ROLES.map((value) => (
              <option key={value} value={value}>
                {t(`roles.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
        {mutation.isError ? (
          <Alert tone="error" title={t('login.errors.failed')}>
            {t(
              isApiError(mutation.error) && mutation.error.code === 'network'
                ? 'login.errors.network'
                : 'login.errors.generic',
            )}
          </Alert>
        ) : null}
        <Button
          type="submit"
          variant="secondary"
          className="rounded-full"
          disabled={mutation.isPending}
        >
          {mutation.isPending ? t('login.signingIn') : t('login.dev.button')}
        </Button>
      </form>
    </Section>
  );
}

function MagicLinkRequest() {
  const { t } = useI18n();
  const api = useApi();
  const ids = useId();
  const [email, setEmail] = useState('');
  const mutation = useMutation({ mutationFn: () => api.requestMagicLink(email) });

  const rateLimited = isApiError(mutation.error) && mutation.error.code === 'rate_limited';
  return (
    <Section title={t('login.client.title')} icon={Mail} tone="teal">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
        className="flex flex-col gap-3"
      >
        <Field label={t('login.email')} htmlFor={`${ids}-email`}>
          <Input
            id={`${ids}-email`}
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              if (mutation.isSuccess || mutation.isError) mutation.reset();
            }}
          />
        </Field>
        <Button
          type="submit"
          variant="secondary"
          className="rounded-full"
          disabled={mutation.isPending}
        >
          <Mail aria-hidden className="size-4" />
          {mutation.isPending ? t('login.client.sending') : t('login.client.button')}
        </Button>
        {/* The same message whether or not the address has an account: nothing to enumerate. */}
        {mutation.isSuccess ? (
          <Alert tone="success" title={t('login.client.sentTitle')}>
            {t('login.client.sentBody')}
          </Alert>
        ) : null}
        {mutation.isError ? (
          <Alert tone="error" title={t('login.errors.failed')}>
            {rateLimited ? t('login.errors.rateLimited') : t('login.errors.generic')}
          </Alert>
        ) : null}
      </form>
    </Section>
  );
}

function BreakGlass({ onSignedIn }: { onSignedIn: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const ids = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const mutation = useMutation({
    mutationFn: () => api.breakGlass({ email, password }),
    onSuccess: onSignedIn,
    onError: () => {
      // Never keep a rejected password in the page.
      setPassword('');
    },
  });

  const code = isApiError(mutation.error) ? mutation.error.code : null;
  return (
    <details className="rounded-2xl bg-surface p-5 ring-1 ring-border/60 ring-inset">
      <summary className="flex cursor-pointer items-center gap-2.5 text-base font-semibold">
        <span
          aria-hidden
          className={cn(
            'inline-flex size-8 shrink-0 items-center justify-center rounded-full',
            TINT_CLASSES.slate.chip,
            TINT_CLASSES.slate.icon,
          )}
        >
          <KeyRound className="size-4" />
        </span>
        {t('login.breakGlass.title')}
      </summary>
      <p className="mt-2 text-sm text-muted-foreground">{t('login.breakGlass.description')}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
        className="mt-3 flex flex-col gap-3"
      >
        <Field label={t('login.email')} htmlFor={`${ids}-email`}>
          <Input
            id={`${ids}-email`}
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </Field>
        <Field label={t('login.password')} htmlFor={`${ids}-password`}>
          <Input
            id={`${ids}-password`}
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </Field>
        {mutation.isError ? (
          <Alert tone="error" title={t('login.errors.failed')}>
            {code === 'rate_limited'
              ? t('login.errors.rateLimited')
              : code === 'invalid_credentials'
                ? t('login.breakGlass.invalid')
                : code === 'network'
                  ? t('login.errors.network')
                  : t('login.errors.generic')}
          </Alert>
        ) : null}
        <Button
          type="submit"
          variant="secondary"
          className="rounded-full"
          disabled={mutation.isPending}
        >
          <KeyRound aria-hidden className="size-4" />
          {mutation.isPending ? t('login.signingIn') : t('login.breakGlass.button')}
        </Button>
      </form>
    </details>
  );
}

/**
 * Sign-in: staff through the provider's single sign-on, customers by emailed link, and a
 * break-glass form for the emergency administrator. Which of these exist comes from
 * `GET /v1/auth/config`; the page assumes nothing about the instance.
 */
export function LoginPage() {
  const { t } = useI18n();
  const api = useApi();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status } = useSession();

  const config = useQuery({
    queryKey: ['auth-config'],
    queryFn: ({ signal }) => api.authConfig(signal),
    retry: false,
    staleTime: 60_000,
  });

  // Someone who is already signed in has nothing to do here.
  useEffect(() => {
    if (status === 'authenticated') router.replace('/');
  }, [status, router]);

  const goHome = () => {
    router.replace('/');
  };
  const failure = parseSsoError(searchParams.get('error'));

  return (
    <LoginLayout>
      <div>
        <h1 className="text-xl font-semibold">{t('login.title')}</h1>
      </div>

      {failure ? (
        <Alert tone="error" title={t('login.sso.errors.title')}>
          {t(SSO_ERROR_KEYS[failure])}
        </Alert>
      ) : null}

      {config.isPending ? (
        <div role="status" className="flex flex-col gap-3">
          <span className="sr-only">{t('login.loading')}</span>
          <Skeleton className="h-24" />
          <Skeleton className="h-32" />
        </div>
      ) : config.isError ? (
        <Alert tone="error" title={t('login.configError.title')}>
          <p>{t('login.configError.body')}</p>
          <Button
            className="mt-2"
            onClick={() => {
              void config.refetch();
            }}
          >
            {t('errors.retry')}
          </Button>
        </Alert>
      ) : (
        <>
          <StaffSso config={config.data} />
          {config.data.devLoginEnabled ? <DevLogin onSignedIn={goHome} /> : null}
          {config.data.magicLinkEnabled ? <MagicLinkRequest /> : null}
          {config.data.breakGlassEnabled ? <BreakGlass onSignedIn={goHome} /> : null}
        </>
      )}
    </LoginLayout>
  );
}
