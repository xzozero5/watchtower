'use client';

import {
  humanClaim,
  weeklyBriefRecipientSchema,
  type Claim,
  type WeeklyBrief,
  type WeeklyBriefContent,
  type WeeklyBriefPublishResult,
} from '@watchtower/shared';
import { Button, IconButton, Input, Skeleton, Textarea } from '@watchtower/ui';
import { ArrowLeft, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { AccessDenied, LoadError, PageHeader } from '@/components/admin/admin-page';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { AppLink } from '@/components/app-link';
import { EvidenceChip } from '@/components/claims/claim-line';
import { useI18n } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { useSession } from '@/lib/auth/session';
import {
  useEditWeeklyBrief,
  usePublishWeeklyBrief,
  useWeeklyBriefDraft,
} from '@/lib/reports/queries';

import { BriefBadges } from './weekly-brief-card';

const dayOf = (iso: string): string => iso.slice(0, 10);

/** Blank sentences, blank titles and causes with nothing to say are dropped when saving: the api wants words. */
function cleaned(content: WeeklyBriefContent): WeeklyBriefContent {
  const keep = (claims: readonly Claim[]): Claim[] =>
    claims
      .map((claim) => ({ ...claim, text: claim.text.trim() }))
      .filter((claim) => claim.text !== '');
  return {
    summary: keep(content.summary),
    rootCauses: content.rootCauses
      .map((cause) => ({
        title: cause.title.trim(),
        claims: keep(cause.claims),
        ask: cause.ask === null || cause.ask.trim() === '' ? null : cause.ask.trim(),
      }))
      .filter((cause) => cause.title !== '' && cause.claims.length > 0),
    decisions: keep(content.decisions),
  };
}

/** One address per line (a comma or semicolon also splits). Duplicates and blanks go; the api lower-cases. */
export function parseRecipients(text: string): { list: string[]; invalid: string[] } {
  const items = [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item !== ''),
    ),
  ];
  const list: string[] = [];
  const invalid: string[] = [];
  for (const item of items) {
    (weeklyBriefRecipientSchema.safeParse(item).success ? list : invalid).push(item);
  }
  return { list, invalid };
}

/**
 * The page where a head edits the draft of the weekly brief and publishes it (T-305c). The words are the head's
 * to change; the evidence is not: a sentence keeps the links the AI had (or none), and a sentence the head writes
 * has no evidence and is shown to readers as such (N5). Head only (`metric.manage`).
 */
export function WeeklyBriefEditPage() {
  const { can } = useSession();
  if (!can('metric.manage')) return <AccessDenied role="head" />;
  return <EditBody />;
}

function EditBody() {
  const { t } = useI18n();
  const query = useWeeklyBriefDraft(true);
  const draft = query.data?.draft ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={t('reports.brief.edit.title')}
        actions={
          <Button asChild size="sm">
            <AppLink href="/dashboard/ceo">
              <ArrowLeft aria-hidden className="size-4" />
              {t('reports.brief.edit.back')}
            </AppLink>
          </Button>
        }
      />
      <main
        id="main-content"
        aria-busy={query.isPending || undefined}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 lg:p-6">
          {query.isError ? (
            <LoadError
              message={t('reports.brief.edit.loadError')}
              onRetry={() => void query.refetch()}
              className="px-0"
            />
          ) : query.isPending ? (
            <div role="status" aria-busy="true">
              <span className="sr-only">{t('reports.brief.edit.loading')}</span>
              <Skeleton className="h-64 rounded-card" />
            </div>
          ) : draft === null ? (
            <p className="rounded-card bg-surface px-5 py-4 text-sm shadow-card">
              {t('reports.brief.edit.none')}
            </p>
          ) : (
            <Editor key={draft.id} draft={draft} defaultRecipients={query.data.defaultRecipients} />
          )}
        </div>
      </main>
    </div>
  );
}

function Editor({
  draft,
  defaultRecipients,
}: {
  draft: WeeklyBrief;
  defaultRecipients: readonly string[];
}) {
  const { t } = useI18n();
  const edit = useEditWeeklyBrief();
  const publish = usePublishWeeklyBrief();
  const [content, setContent] = useState<WeeklyBriefContent>(draft.content);
  const [saved, setSaved] = useState<WeeklyBriefContent>(draft.content);
  const [recipientsText, setRecipientsText] = useState(defaultRecipients.join('\n'));
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState<WeeklyBriefPublishResult | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const recipientsId = useId();

  const dirty = useMemo(
    () => JSON.stringify(cleaned(content)) !== JSON.stringify(cleaned(saved)),
    [content, saved],
  );
  const recipients = useMemo(() => parseRecipients(recipientsText), [recipientsText]);

  const change = (next: WeeklyBriefContent) => {
    setContent(next);
    setJustSaved(false);
  };

  const save = async (): Promise<boolean> => {
    const next = cleaned(content);
    try {
      await edit.mutateAsync({ id: draft.id, content: next });
    } catch {
      return false;
    }
    setContent(next);
    setSaved(next);
    setJustSaved(true);
    return true;
  };

  const confirmPublish = async () => {
    if (dirty && !(await save())) {
      setAsking(false);
      return;
    }
    try {
      setDone(await publish.mutateAsync({ id: draft.id, recipients: recipients.list }));
    } catch {
      // The dialog shows the error and stays open.
    }
  };

  if (done !== null) {
    return (
      <div className="flex max-w-3xl flex-col gap-3 rounded-card bg-surface px-5 py-4 shadow-card">
        <p role="status" className="text-sm font-medium">
          {done.queued === 0
            ? t('reports.brief.edit.publishedNone')
            : t('reports.brief.edit.published', { count: done.queued })}
        </p>
        <div>
          <Button asChild variant="primary" size="sm">
            <AppLink href="/dashboard/ceo">{t('reports.brief.edit.openCeo')}</AppLink>
          </Button>
        </div>
      </div>
    );
  }

  const claimsEditor = (
    claims: readonly Claim[],
    set: (next: Claim[]) => void,
    label: (number: number) => string,
    removeLabel: (number: number) => string,
  ) => (
    <ul className="flex flex-col gap-3">
      {claims.map((claim, index) => (
        <li key={index} className="flex flex-col gap-1.5">
          <div className="flex items-start gap-2">
            <Textarea
              rows={2}
              maxLength={600}
              value={claim.text}
              aria-label={label(index + 1)}
              className="flex-1"
              onChange={(event) => {
                set(
                  claims.map((item, at) =>
                    at === index ? { ...item, text: event.target.value } : item,
                  ),
                );
              }}
            />
            <IconButton
              variant="ghost"
              label={removeLabel(index + 1)}
              icon={<Trash2 aria-hidden className="size-4" />}
              onClick={() => {
                set(claims.filter((_, at) => at !== index));
              }}
            />
          </div>
          {claim.uncited ? (
            <p className="text-xs text-muted-foreground">{t('assistant.answer.uncited')}</p>
          ) : (
            <div
              className="flex flex-wrap items-center gap-1"
              role="group"
              aria-label={t('assistant.answer.evidence')}
            >
              {claim.evidence.map((evidence, at) => (
                <EvidenceChip
                  key={`${evidence.kind}-${evidence.label}-${String(at)}`}
                  evidence={evidence}
                  canOpenOrgs
                />
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );

  const addButton = (onClick: () => void, text: string) => (
    <div>
      <Button size="sm" onClick={onClick}>
        <Plus aria-hidden className="size-4" />
        {text}
      </Button>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>
            {t('reports.brief.edit.forPeriod', {
              from: dayOf(draft.periodFrom),
              to: dayOf(draft.periodTo),
            })}
          </span>
          <BriefBadges brief={draft} />
        </div>
        <p className="text-sm">
          {draft.source === 'data_only'
            ? t('reports.brief.edit.figuresOnlyNote', { reason: draft.reasonCode ?? '-' })
            : t('reports.brief.edit.aiNote')}
        </p>
      </div>

      <section aria-labelledby="edit-summary" className="flex flex-col gap-3">
        <h2 id="edit-summary" className="text-title font-medium text-foreground-strong">
          {t('reports.brief.section.summary')}
        </h2>
        {claimsEditor(
          content.summary,
          (next) => {
            change({ ...content, summary: next });
          },
          (number) => t('reports.brief.edit.sentence', { number }),
          (number) => t('reports.brief.edit.remove', { number }),
        )}
        {addButton(() => {
          change({ ...content, summary: [...content.summary, humanClaim('')] });
        }, t('reports.brief.edit.add'))}
        <p className="text-xs text-muted-foreground">{t('reports.brief.edit.addNote')}</p>
      </section>

      <section aria-labelledby="edit-causes" className="flex flex-col gap-3">
        <h2 id="edit-causes" className="text-title font-medium text-foreground-strong">
          {t('reports.brief.section.rootCauses')}
        </h2>
        <ol className="flex flex-col gap-5">
          {content.rootCauses.map((cause, index) => (
            <li
              key={index}
              className="flex flex-col gap-2 rounded-card bg-surface px-4 py-3 shadow-card"
            >
              <div className="flex items-start gap-2">
                <Input
                  value={cause.title}
                  maxLength={160}
                  aria-label={t('reports.brief.edit.causeTitle', { number: index + 1 })}
                  className="flex-1"
                  onChange={(event) => {
                    change({
                      ...content,
                      rootCauses: content.rootCauses.map((item, at) =>
                        at === index ? { ...item, title: event.target.value } : item,
                      ),
                    });
                  }}
                />
                <IconButton
                  variant="ghost"
                  label={t('reports.brief.edit.removeCause', { number: index + 1 })}
                  icon={<Trash2 aria-hidden className="size-4" />}
                  onClick={() => {
                    change({
                      ...content,
                      rootCauses: content.rootCauses.filter((_, at) => at !== index),
                    });
                  }}
                />
              </div>
              {claimsEditor(
                cause.claims,
                (next) => {
                  change({
                    ...content,
                    rootCauses: content.rootCauses.map((item, at) =>
                      at === index ? { ...item, claims: next } : item,
                    ),
                  });
                },
                () => t('reports.brief.edit.causeText', { number: index + 1 }),
                () => t('reports.brief.edit.removeCause', { number: index + 1 }),
              )}
              <Input
                value={cause.ask ?? ''}
                maxLength={300}
                aria-label={t('reports.brief.edit.causeAsk', { number: index + 1 })}
                placeholder={t('reports.brief.ask')}
                onChange={(event) => {
                  change({
                    ...content,
                    rootCauses: content.rootCauses.map((item, at) =>
                      at === index
                        ? { ...item, ask: event.target.value === '' ? null : event.target.value }
                        : item,
                    ),
                  });
                }}
              />
            </li>
          ))}
        </ol>
        {content.rootCauses.length >= 5
          ? null
          : addButton(() => {
              change({
                ...content,
                rootCauses: [
                  ...content.rootCauses,
                  { title: '', claims: [humanClaim('')], ask: null },
                ],
              });
            }, t('reports.brief.edit.addCause'))}
      </section>

      <section aria-labelledby="edit-decisions" className="flex flex-col gap-3">
        <h2 id="edit-decisions" className="text-title font-medium text-foreground-strong">
          {t('reports.brief.section.decisions')}
        </h2>
        {claimsEditor(
          content.decisions,
          (next) => {
            change({ ...content, decisions: next });
          },
          (number) => t('reports.brief.edit.decision', { number }),
          (number) => t('reports.brief.edit.removeDecision', { number }),
        )}
        {content.decisions.length >= 5
          ? null
          : addButton(() => {
              change({ ...content, decisions: [...content.decisions, humanClaim('')] });
            }, t('reports.brief.edit.add'))}
      </section>

      <section className="flex max-w-xl flex-col gap-2">
        <label htmlFor={`${recipientsId}-field`} id={recipientsId} className="text-sm font-medium">
          {t('reports.brief.edit.recipients')}
        </label>
        <Textarea
          id={`${recipientsId}-field`}
          rows={4}
          value={recipientsText}
          spellCheck={false}
          aria-describedby={`${recipientsId}-hint`}
          onChange={(event) => {
            setRecipientsText(event.target.value);
          }}
        />
        <p id={`${recipientsId}-hint`} className="text-xs text-muted-foreground">
          {t('reports.brief.edit.recipientsHint')}
        </p>
        {recipients.invalid.length > 0 ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {t('reports.brief.edit.recipientsInvalid', { value: recipients.invalid.join(', ') })}
          </p>
        ) : null}
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={!dirty || edit.isPending}
          onClick={() => {
            void save();
          }}
        >
          {edit.isPending ? t('reports.brief.edit.saving') : t('reports.brief.edit.save')}
        </Button>
        <Button
          disabled={draft.aiContent === null || edit.isPending}
          onClick={() => {
            if (draft.aiContent !== null) change(draft.aiContent);
          }}
        >
          <RotateCcw aria-hidden className="size-4" />
          {t('reports.brief.edit.restore')}
        </Button>
        <Button
          disabled={recipients.invalid.length > 0 || edit.isPending}
          onClick={() => {
            setAsking(true);
          }}
        >
          {t('reports.brief.edit.publish')}
        </Button>
        {dirty ? (
          <span role="status" className="text-sm text-muted-foreground">
            {t('reports.brief.edit.dirty')}
          </span>
        ) : justSaved ? (
          <span role="status" className="text-sm font-medium">
            {t('reports.brief.edit.saved')}
          </span>
        ) : null}
      </div>
      {edit.isError ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {t('reports.brief.edit.saveFailed', { message: describeError(edit.error, t).message })}
        </p>
      ) : null}

      <ConfirmDialog
        open={asking}
        onOpenChange={(open) => {
          setAsking(open);
          if (!open) publish.reset();
        }}
        title={t('reports.brief.edit.publishTitle')}
        description={
          recipients.list.length === 0
            ? t('reports.brief.edit.publishBodyNone')
            : t('reports.brief.edit.publishBody', { count: recipients.list.length })
        }
        confirmLabel={t('reports.brief.edit.publishConfirm')}
        pending={publish.isPending || edit.isPending}
        error={publish.isError ? describeError(publish.error, t).message : null}
        onConfirm={() => {
          void confirmPublish();
        }}
      />
    </div>
  );
}
