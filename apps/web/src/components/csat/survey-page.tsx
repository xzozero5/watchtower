'use client';

import { CSAT_COMMENT_MAX_LENGTH, type CsatSurveyView } from '@watchtower/shared';
import { Alert, Button, Textarea } from '@watchtower/ui';
import { CircleCheck, Link2Off } from 'lucide-react';
import { type SyntheticEvent, useEffect, useId, useState } from 'react';

import type { MessageKey } from '@/i18n';
import { useI18n } from '@/i18n/provider';
import { forgetSurveyLink, claimSurveyLink } from '@/lib/csat/survey-link';
import { classifyPortalError } from '@/lib/portal/portal-client';
import { formatWait } from '@/lib/portal/portal-format';
import { usePortalApi } from '@/lib/portal/use-portal';

import { describedBy, FormField } from '../portal/form-field';

type Phase =
  | { readonly name: 'loading' }
  | { readonly name: 'ready'; readonly token: string; readonly view: CsatSurveyView }
  | { readonly name: 'done' }
  | { readonly name: 'answered' }
  | { readonly name: 'invalid' }
  | { readonly name: 'failed'; readonly key: MessageKey; readonly wait: number | null };

const SCORES = [1, 2, 3, 4, 5] as const;
const SCORE_LABELS = {
  1: 'csat.score.s1',
  2: 'csat.score.s2',
  3: 'csat.score.s3',
  4: 'csat.score.s4',
  5: 'csat.score.s5',
} as const satisfies Record<(typeof SCORES)[number], MessageKey>;

/**
 * The public CSAT survey (PRD R-10.2, T-110b). Opened from the email: the fragment carries the
 * single-use link and the rating chosen there. The page takes the link out of the address bar,
 * shows which request it is about, and sends the answer once. Nothing is recorded until the
 * customer presses the button, so a mail scanner that opens every link in the email answers
 * nothing. The page never says whether an answer reopened the request.
 */
export function SurveyPage() {
  const { t, locale } = useI18n();
  const api = usePortalApi();
  const uid = useId();
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [score, setScore] = useState<number | null>(null);
  const [resolved, setResolved] = useState<boolean | null>(null);
  const [comment, setComment] = useState('');
  const [fieldError, setFieldError] = useState<MessageKey | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<{ key: MessageKey; wait: number | null } | null>(null);

  useEffect(() => {
    const link = claimSurveyLink();
    const controller = new AbortController();
    // Every state change happens after a promise settles, never synchronously in the effect.
    const outcome: Promise<Phase | null> =
      link === null
        ? Promise.resolve<Phase>({ name: 'invalid' })
        : api.csatSurvey(link.token, controller.signal).then(
            (view): Phase => ({ name: 'ready', token: link.token, view }),
            (error: unknown): Phase | null => {
              if (error instanceof DOMException && error.name === 'AbortError') return null;
              const failed = classifyPortalError(error);
              if (failed.kind === 'invalidLink') {
                forgetSurveyLink();
                return { name: 'invalid' };
              }
              if (failed.kind === 'notOpen') {
                forgetSurveyLink();
                return { name: 'answered' };
              }
              return {
                name: 'failed',
                key: failed.kind === 'network' ? 'csat.errors.network' : 'csat.errors.server',
                wait: failed.retryAfterSeconds,
              };
            },
          );
    void outcome.then((next) => {
      if (next === null || controller.signal.aborted) return;
      const chosen = link?.score ?? null;
      if (chosen !== null) setScore((current) => current ?? chosen);
      setPhase(next);
    });
    return () => {
      controller.abort();
    };
  }, [api]);

  if (phase.name === 'loading') {
    return (
      <p role="status" className="text-muted-foreground">
        {t('csat.loading')}
      </p>
    );
  }
  if (phase.name === 'failed') {
    return <Alert tone="error" title={t(phase.key)} />;
  }
  if (phase.name === 'done') {
    return (
      <Notice
        icon={<CircleCheck aria-hidden className="mt-1 size-6 shrink-0 text-success" />}
        title={t('csat.done.title')}
        body={t('csat.done.body')}
      />
    );
  }
  if (phase.name === 'answered') {
    return (
      <Notice
        icon={<CircleCheck aria-hidden className="mt-1 size-6 shrink-0 text-success" />}
        title={t('csat.answered.title')}
        body={t('csat.answered.body')}
      />
    );
  }
  if (phase.name === 'invalid') {
    return (
      <Notice
        icon={<Link2Off aria-hidden className="mt-1 size-6 shrink-0 text-muted-foreground" />}
        title={t('csat.invalid.title')}
        body={t('csat.invalid.body')}
      />
    );
  }

  const { token, view } = phase;
  const commentId = `${uid}-comment`;

  const onSubmit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (sending) return;
    setFailure(null);
    if (score === null) {
      setFieldError('csat.errors.scoreRequired');
      document.getElementById(`${uid}-score-1`)?.focus();
      return;
    }
    if (comment.trim().length > CSAT_COMMENT_MAX_LENGTH) {
      setFieldError('csat.errors.commentTooLong');
      document.getElementById(commentId)?.focus();
      return;
    }
    setFieldError(null);
    setSending(true);
    try {
      await api.csatAnswer(token, {
        score,
        ...(resolved === null ? {} : { resolved }),
        ...(comment.trim() === '' ? {} : { comment: comment.trim() }),
      });
      forgetSurveyLink();
      setPhase({ name: 'done' });
    } catch (error) {
      const failed = classifyPortalError(error);
      if (failed.kind === 'invalidLink') {
        forgetSurveyLink();
        setPhase({ name: 'invalid' });
      } else if (failed.kind === 'notOpen') {
        forgetSurveyLink();
        setPhase({ name: 'answered' });
      } else {
        setFailure({
          key:
            failed.kind === 'rateLimited'
              ? 'csat.errors.rateLimited'
              : failed.kind === 'network'
                ? 'csat.errors.network'
                : failed.kind === 'validation'
                  ? 'csat.errors.commentTooLong'
                  : 'csat.errors.server',
          wait: failed.retryAfterSeconds,
        });
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">{t('csat.title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('csat.intro', { key: view.ticketKey })}</p>
      </div>
      <form noValidate onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-5">
        <fieldset
          className="flex flex-col gap-2"
          aria-describedby={
            fieldError === 'csat.errors.scoreRequired' ? `${uid}-score-error` : undefined
          }
        >
          <legend className="text-sm font-medium">{t('csat.score.legend')}</legend>
          <div className="flex flex-wrap gap-2">
            {SCORES.map((value) => (
              <label
                key={value}
                htmlFor={`${uid}-score-${String(value)}`}
                className="flex min-w-20 cursor-pointer flex-col items-center gap-1 rounded-md border border-border px-3 py-2 text-center text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:focus-visible]:ring-2"
              >
                <input
                  id={`${uid}-score-${String(value)}`}
                  type="radio"
                  name="score"
                  value={value}
                  checked={score === value}
                  aria-label={t('csat.score.option', {
                    score: value,
                    label: t(SCORE_LABELS[value]),
                  })}
                  onChange={() => {
                    setScore(value);
                    setFieldError(null);
                  }}
                />
                <span className="text-lg font-semibold" aria-hidden>
                  {value}
                </span>
                <span className="text-xs text-muted-foreground" aria-hidden>
                  {t(SCORE_LABELS[value])}
                </span>
              </label>
            ))}
          </div>
          {fieldError === 'csat.errors.scoreRequired' ? (
            <p id={`${uid}-score-error`} role="alert" className="text-sm font-medium text-danger">
              {t(fieldError)}
            </p>
          ) : null}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t('csat.resolved.legend')}</legend>
          <div className="flex flex-col gap-1 sm:flex-row sm:gap-5">
            {([true, false] as const).map((value) => (
              <label key={String(value)} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="resolved"
                  checked={resolved === value}
                  onChange={() => {
                    setResolved(value);
                  }}
                />
                {value ? t('csat.resolved.yes') : t('csat.resolved.no')}
              </label>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">{t('csat.resolved.hint')}</p>
        </fieldset>

        <FormField
          id={commentId}
          label={t('csat.comment.label')}
          optionalLabel={t('csat.comment.optional')}
          hint={t('csat.comment.count', { count: comment.length, max: CSAT_COMMENT_MAX_LENGTH })}
          error={fieldError === 'csat.errors.commentTooLong' ? t(fieldError) : undefined}
        >
          <Textarea
            id={commentId}
            name="comment"
            rows={4}
            aria-invalid={fieldError === 'csat.errors.commentTooLong' ? true : undefined}
            aria-describedby={describedBy(
              commentId,
              true,
              fieldError === 'csat.errors.commentTooLong',
            )}
            value={comment}
            onChange={(event) => {
              setComment(event.target.value);
              if (fieldError === 'csat.errors.commentTooLong') setFieldError(null);
            }}
          />
        </FormField>

        {failure ? (
          <Alert
            tone="error"
            title={t(failure.key, { time: formatWait(failure.wait ?? 60, locale) })}
          />
        ) : null}
        <Button
          type="submit"
          variant="primary"
          className="w-full sm:w-auto sm:self-start"
          disabled={sending}
          aria-busy={sending}
        >
          {sending ? t('csat.sending') : t('csat.submit')}
        </Button>
      </form>
    </>
  );
}

function Notice({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3" role="status">
      {icon}
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-1 text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
