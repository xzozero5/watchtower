'use client';

import { PORTAL_CATEGORIES, PORTAL_URGENCIES, type PortalLocale } from '@watchtower/shared';
import { Alert, Button, cn, Input, Select, TINT_CLASSES, Textarea } from '@watchtower/ui';
import { CircleHelp, Flame, Send, Wrench } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type SyntheticEvent, useEffect, useId, useRef, useState } from 'react';

import type { MessageKey } from '@/i18n';
import { useI18n } from '@/i18n/provider';
import {
  EMPTY_FORM,
  FORM_FIELDS,
  isFormField,
  isPortalCategory,
  isPortalUrgency,
  validateForm,
  withoutError,
  type FormErrors,
  type FormField as FieldName,
  type FormValues,
} from '@/lib/portal/form-model';
import { PowRefusedError } from '@/lib/portal/pow-core';
import { classifyPortalError, type PortalFailureKind } from '@/lib/portal/portal-client';
import { formatWait } from '@/lib/portal/portal-format';
import { saveSubmitted } from '@/lib/portal/submitted-handoff';
import { submitRequest } from '@/lib/portal/submit-flow';
import { useHumanCheck, usePortalApi } from '@/lib/portal/use-portal';

import { AttachmentPicker, useAttachments } from './attachment-picker';
import { describedBy, FormField } from './form-field';
import { HumanCheckStatus } from './human-check-status';

const CATEGORY_KEYS: Record<(typeof PORTAL_CATEGORIES)[number], MessageKey> = {
  outage: 'portal.form.categories.outage',
  api_error: 'portal.form.categories.apiError',
  processing_failure: 'portal.form.categories.processingFailure',
  webhook: 'portal.form.categories.webhook',
  account_access: 'portal.form.categories.accountAccess',
  billing: 'portal.form.categories.billing',
  configuration: 'portal.form.categories.configuration',
  question: 'portal.form.categories.question',
  other: 'portal.form.categories.other',
};

const URGENCY_KEYS: Record<
  (typeof PORTAL_URGENCIES)[number],
  { label: MessageKey; hint: MessageKey }
> = {
  everything_down: {
    label: 'portal.form.urgencies.everythingDown',
    hint: 'portal.form.urgencyHints.everythingDown',
  },
  something_broken: {
    label: 'portal.form.urgencies.somethingBroken',
    hint: 'portal.form.urgencyHints.somethingBroken',
  },
  question: {
    label: 'portal.form.urgencies.question',
    hint: 'portal.form.urgencyHints.question',
  },
};

/** Each urgency has an icon in its hue (red only for "everything is down"); the words stay beside it. */
const URGENCY_LOOK = {
  everything_down: { icon: Flame, tone: 'red' },
  something_broken: { icon: Wrench, tone: 'amber' },
  question: { icon: CircleHelp, tone: 'sky' },
} as const;

function UrgencyIcon({ urgency }: { urgency: (typeof PORTAL_URGENCIES)[number] }) {
  const { icon: Icon, tone } = URGENCY_LOOK[urgency];
  return (
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
  );
}

const FIELD_LABELS: Record<FieldName, MessageKey> = {
  name: 'portal.form.name',
  email: 'portal.form.email',
  organization: 'portal.form.organization',
  category: 'portal.form.category',
  subject: 'portal.form.subject',
  description: 'portal.form.description',
  requestIds: 'portal.form.requestIds',
};

type Failure = PortalFailureKind | 'verifyUnavailable';

const FAILURE_KEYS: Record<Exclude<Failure, 'invalidLink' | 'notOpen'>, MessageKey> = {
  verification: 'portal.form.failures.verification',
  rateLimited: 'portal.form.failures.rateLimited',
  network: 'portal.form.failures.network',
  validation: 'portal.form.failures.validation',
  attachment: 'portal.form.failures.attachment',
  server: 'portal.form.failures.server',
  verifyUnavailable: 'portal.verifyFailed',
};

function failureKey(failure: Failure): MessageKey {
  return failure === 'invalidLink' || failure === 'notOpen'
    ? FAILURE_KEYS.server
    : FAILURE_KEYS[failure];
}

/**
 * The public request form (UI spec section 10). Labels above fields, errors inline and in a
 * summary, urgency in plain words. The human check (proof-of-work in a Web Worker) starts when the
 * form opens and the person can keep typing; Submit waits for it if it is not done yet.
 */
export function SubmitForm() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const api = usePortalApi();
  const { check, state: checkState } = useHumanCheck(api);
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;

  const attachments = useAttachments();
  const [values, setValues] = useState<FormValues>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [blockedUntil, setBlockedUntil] = useState(0);
  const [summaryVersion, setSummaryVersion] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);

  // After a submit with problems, move focus to the summary so it is read out.
  useEffect(() => {
    if (summaryVersion > 0) summaryRef.current?.focus();
  }, [summaryVersion]);

  // A rate limit disables Submit until the wait is over.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (blockedUntil <= Date.now()) return;
    const timer = setTimeout(
      () => {
        setNow(Date.now());
      },
      blockedUntil - Date.now() + 50,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [blockedUntil]);
  const blocked = blockedUntil > now;

  const portalLocale: PortalLocale = locale;
  const errorFields = FORM_FIELDS.filter((field) => errors[field] !== undefined);

  const set = <K extends keyof FormValues>(field: K, value: FormValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
    if (isFormField(field)) setErrors((current) => withoutError(current, field));
  };

  const onSubmit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (submitting || blocked) return;
    const result = validateForm(values, portalLocale);
    if (!result.ok) {
      setErrors(result.errors);
      setFailure(Object.keys(result.errors).length === 0 ? 'validation' : null);
      setSummaryVersion((version) => version + 1);
      return;
    }
    setErrors({});
    setFailure(null);
    setSubmitting(true);
    try {
      const submitted = await submitRequest({ api, check }, result.payload, attachments.files);
      saveSubmitted(submitted);
      router.push('/portal/submitted');
    } catch (error) {
      if (error instanceof PowRefusedError) {
        setFailure('verifyUnavailable');
      } else {
        const classified = classifyPortalError(error);
        setFailure(classified.kind);
        setRetryAfter(classified.retryAfterSeconds);
        // A challenge works once. After a refusal or a limit the next try needs a new one.
        if (classified.kind === 'verification' || classified.kind === 'rateLimited') {
          check.restart();
        }
        if (classified.kind === 'rateLimited') {
          const until = Date.now() + (classified.retryAfterSeconds ?? 60) * 1000;
          setBlockedUntil(until);
          setNow(Date.now());
        }
      }
      setSubmitting(false);
      setSummaryVersion((version) => version + 1);
    }
  };

  const fieldProps = (field: FieldName, hasHint: boolean) => {
    const key = errors[field];
    return {
      id: id(field),
      'aria-invalid': key !== undefined ? true : undefined,
      'aria-describedby': describedBy(id(field), hasHint, key !== undefined),
    };
  };
  const errorText = (field: FieldName) => {
    const key = errors[field];
    return key === undefined ? undefined : t(key);
  };

  const failureText =
    failure === null
      ? null
      : t(failureKey(failure), {
          time: formatWait(retryAfter ?? 60, locale),
        });

  const buttonLabel = !submitting
    ? t('portal.submit')
    : checkState.phase === 'ready'
      ? t('portal.form.sending')
      : t('portal.form.waiting');

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">{t('portal.form.title')}</h1>
      </div>

      <form noValidate onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-5">
        <div ref={summaryRef} tabIndex={-1} className="empty:hidden">
          {errorFields.length > 0 ? (
            <Alert tone="error" title={t('portal.form.errorSummary')}>
              <p>{t('portal.form.errorSummaryHint')}</p>
              <ul className="mt-1 list-disc pl-5">
                {errorFields.map((field) => {
                  const key = errors[field];
                  return key === undefined ? null : (
                    <li key={field}>
                      <a
                        href={`#${id(field)}`}
                        className="text-link underline underline-offset-2"
                        onClick={(event) => {
                          event.preventDefault();
                          document.getElementById(id(field))?.focus();
                        }}
                      >
                        {t(FIELD_LABELS[field])}
                      </a>
                      : {t(key)}
                    </li>
                  );
                })}
              </ul>
            </Alert>
          ) : failureText ? (
            <Alert tone="error" title={failureText} />
          ) : null}
        </div>

        <FormField id={id('name')} label={t('portal.form.name')} error={errorText('name')}>
          <Input
            {...fieldProps('name', false)}
            name="name"
            autoComplete="name"
            value={values.name}
            onChange={(event) => {
              set('name', event.target.value);
            }}
          />
        </FormField>

        <FormField
          id={id('email')}
          label={t('portal.form.email')}
          hint={t('portal.form.emailHint')}
          error={errorText('email')}
        >
          <Input
            {...fieldProps('email', true)}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={values.email}
            onChange={(event) => {
              set('email', event.target.value);
            }}
          />
        </FormField>

        <FormField
          id={id('organization')}
          label={t('portal.form.organization')}
          optionalLabel={t('portal.optional')}
          error={errorText('organization')}
        >
          <Input
            {...fieldProps('organization', true)}
            name="organization"
            autoComplete="organization"
            value={values.organization}
            onChange={(event) => {
              set('organization', event.target.value);
            }}
          />
        </FormField>

        <FormField
          id={id('category')}
          label={t('portal.form.category')}
          error={errorText('category')}
        >
          <Select
            {...fieldProps('category', false)}
            name="category"
            value={values.category}
            onChange={(event) => {
              const next = event.target.value;
              set('category', isPortalCategory(next) ? next : '');
            }}
          >
            <option value="">{t('portal.form.categoryChoose')}</option>
            {PORTAL_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(CATEGORY_KEYS[category])}
              </option>
            ))}
          </Select>
        </FormField>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">
            {t('portal.form.urgency')}{' '}
            <span className="font-normal text-muted-foreground">({t('portal.optional')})</span>
          </legend>
          {PORTAL_URGENCIES.map((urgency) => {
            const radioId = id(`urgency-${urgency}`);
            return (
              <label
                key={urgency}
                htmlFor={radioId}
                className="flex cursor-pointer items-center gap-3 rounded-xl bg-surface px-3 py-2.5 ring-1 ring-border-strong transition-colors duration-(--wt-motion-duration-fast) ease-out ring-inset has-[:checked]:bg-primary-subtle has-[:checked]:ring-2 has-[:checked]:ring-ring"
              >
                <input
                  id={radioId}
                  type="radio"
                  name="urgency"
                  value={urgency}
                  checked={values.urgency === urgency}
                  onChange={() => {
                    if (isPortalUrgency(urgency)) set('urgency', urgency);
                  }}
                  className="size-4 accent-primary"
                />
                <UrgencyIcon urgency={urgency} />
                <span className="flex flex-col">
                  <span className="text-sm font-medium">{t(URGENCY_KEYS[urgency].label)}</span>
                  <span className="text-sm text-muted-foreground">
                    {t(URGENCY_KEYS[urgency].hint)}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>

        <FormField
          id={id('subject')}
          label={t('portal.form.subject')}
          optionalLabel={t('portal.optional')}
          error={errorText('subject')}
        >
          <Input
            {...fieldProps('subject', true)}
            name="subject"
            value={values.subject}
            onChange={(event) => {
              set('subject', event.target.value);
            }}
          />
        </FormField>

        <FormField
          id={id('description')}
          label={t('portal.form.description')}
          error={errorText('description')}
        >
          <Textarea
            {...fieldProps('description', true)}
            name="description"
            rows={6}
            value={values.description}
            onChange={(event) => {
              set('description', event.target.value);
            }}
          />
        </FormField>

        <FormField
          id={id('requestIds')}
          label={t('portal.form.requestIds')}
          optionalLabel={t('portal.optional')}
          hint={t('portal.form.requestIdsHint')}
          error={errorText('requestIds')}
        >
          <Textarea
            {...fieldProps('requestIds', true)}
            name="requestIds"
            rows={3}
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
            value={values.requestIds}
            onChange={(event) => {
              set('requestIds', event.target.value);
            }}
          />
        </FormField>

        <AttachmentPicker state={attachments} disabled={submitting} />

        {/* Honeypot: invisible and unreachable for people, tempting for form-filling bots. */}
        <div aria-hidden="true" className="sr-only" data-testid="portal-honeypot">
          <label>
            Website
            <input
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              value={values.website}
              onChange={(event) => {
                set('website', event.target.value);
              }}
            />
          </label>
        </div>

        <HumanCheckStatus
          state={checkState}
          onRetry={() => {
            check.restart();
          }}
        />

        <Button
          type="submit"
          variant="primary"
          className="w-full rounded-full sm:w-auto sm:self-start"
          disabled={submitting || blocked}
          aria-busy={submitting}
        >
          <Send aria-hidden className="size-4" />
          {buttonLabel}
        </Button>
      </form>
    </>
  );
}
