'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  STATUS_LOCALES,
  STATUS_POST_IMPACTS,
  STATUS_POST_PHASES,
  type StatusComponent,
  type StatusLocale,
  type StatusPostImpact,
  type StatusPostPhase,
  type StatusPostStaff,
} from '@watchtower/shared';
import { Button, EmptyState, Input, Select, Textarea, TintChip, toast } from '@watchtower/ui';
import { Bot, FilePen, Megaphone, Plus, UserRound } from 'lucide-react';
import { useId, useState } from 'react';

import { LoadError } from '@/components/admin/admin-page';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { EntitySheet } from '@/components/admin/entity-sheet';
import { Moment, OpsSkeleton } from '@/components/ops/ops-bits';
import { PublishDialog } from '@/components/ops/status/publish-dialog';
import { ImpactText, StatusPhaseChip } from '@/components/ops/status/status-bits';
import { FormField } from '@/components/portal/form-field';
import { IntroHint } from '@/components/intro-hint';
import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { useSession, useUserId } from '@/lib/auth/session';
import { describeOpsError } from '@/lib/ops/model';
import {
  opsKeys,
  useIncidentList,
  useStatusComponents,
  useStatusPosts,
  useStatusSubscribers,
} from '@/lib/ops/queries';

/** A set of checkboxes for the components a post or window names. */
export function ComponentPicker({
  id,
  legend,
  components,
  value,
  onChange,
  error,
}: {
  id: string;
  legend: string;
  components: readonly StatusComponent[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  error?: string | undefined;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="flex flex-col gap-1" aria-describedby={error ? `${id}-error` : undefined}>
      <legend className="text-sm font-medium">{legend}</legend>
      {components.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('ops.statusAdmin.noComponents')}</p>
      ) : (
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          {components.map((component) => (
            <li key={component.id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={value.includes(component.id)}
                  onChange={(event) => {
                    onChange(
                      event.target.checked
                        ? [...value, component.id]
                        : value.filter((item) => item !== component.id),
                    );
                  }}
                />
                {component.name}
              </label>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p id={`${id}-error`} className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

type PostFilter = 'all' | 'draft' | 'published';

/**
 * Posts on the status page (R-6.2, R-6.3). Anyone who may open an incident drafts; publishing is a
 * person with `incident.manage` pressing a button after reading exactly what goes public and how
 * many confirmed subscribers are told (N3). The AI may draft, never publish.
 */
export function StatusPostsSection() {
  const { t } = useI18n();
  const { can } = useSession();
  const [filter, setFilter] = useState<PostFilter>('all');
  const query = filter === 'all' ? {} : { state: filter };
  const list = useStatusPosts(query);
  const components = useStatusComponents();
  const [editing, setEditing] = useState<StatusPostStaff | 'new' | null>(null);
  const [templating, setTemplating] = useState(false);
  const [publishing, setPublishing] = useState<StatusPostStaff | null>(null);
  const [deleting, setDeleting] = useState<StatusPostStaff | null>(null);
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const draftRight = can('incident.create');
  const publishRight = can('incident.manage');
  const nameOf = (id: string) => components.data?.items.find((c) => c.id === id)?.name ?? id;
  const openIncidents = useIncidentList({ open: true });
  const incidentKeyOf = (id: string) =>
    openIncidents.data?.pages.flatMap((page) => page.items).find((item) => item.id === id)?.key;
  const filterId = useId();
  return (
    <section aria-label={t('ops.statusAdmin.posts.title')} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('ops.statusAdmin.posts.title')}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={filterId} className="text-sm">
            {t('ops.statusAdmin.posts.filter')}
          </label>
          <Select
            id={filterId}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as PostFilter);
            }}
          >
            <option value="all">{t('ops.statusAdmin.posts.filterAll')}</option>
            <option value="draft">{t('ops.statusAdmin.posts.state.draft')}</option>
            <option value="published">{t('ops.statusAdmin.posts.state.published')}</option>
          </Select>
          {draftRight ? (
            <>
              <Button
                onClick={() => {
                  setTemplating(true);
                }}
              >
                {t('ops.statusAdmin.posts.fromIncident')}
              </Button>
              <Button
                onClick={() => {
                  setEditing('new');
                }}
              >
                <Plus aria-hidden className="size-4" />
                {t('ops.statusAdmin.posts.add')}
              </Button>
            </>
          ) : null}
        </div>
      </div>
      <IntroHint topic={t('ops.statusAdmin.posts.title')}>
        {t('ops.statusAdmin.posts.intro')}
      </IntroHint>
      {list.isPending ? (
        <OpsSkeleton rows={3} />
      ) : list.isError ? (
        <LoadError onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={<Megaphone />} title={t('ops.statusAdmin.posts.empty')} />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((post) => (
            <li
              key={post.id}
              className="flex flex-col gap-1.5 rounded-inner bg-surface px-3.5 py-2.5 shadow-card text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <TintChip
                  tone={post.state === 'published' ? 'green' : 'amber'}
                  icon={post.state === 'published' ? Megaphone : FilePen}
                >
                  {t(`ops.statusAdmin.posts.state.${post.state}`)}
                </TintChip>
                <StatusPhaseChip phase={post.phase} />
                <TintChip tone="slate" icon={post.origin === 'ai' ? Bot : UserRound}>
                  {t(`ops.incidents.comms.origin.${post.origin}`)}
                </TintChip>
                <span className="text-xs text-muted-foreground">
                  <Moment iso={post.publishedAt ?? post.updatedAt} />
                </span>
              </div>
              <p className="font-medium break-words">{post.title}</p>
              <p className="whitespace-pre-wrap break-words text-muted-foreground">{post.body}</p>
              <p className="text-xs text-muted-foreground">
                {t('ops.statusAdmin.posts.impact')}: <ImpactText impact={post.impact} />
                {post.componentIds.length > 0
                  ? ` · ${post.componentIds.map(nameOf).join(', ')}`
                  : ` · ${t('ops.statusAdmin.posts.noComponent')}`}
                {' · '}
                {post.incidentId === null
                  ? t('ops.statusAdmin.posts.noIncident')
                  : t('ops.statusAdmin.posts.linkedIncident', {
                      key: incidentKeyOf(post.incidentId) ?? t('ops.statusAdmin.posts.anIncident'),
                    })}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {post.state === 'draft' && draftRight ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setEditing(post);
                    }}
                  >
                    {t('ops.common.edit')}
                  </Button>
                ) : null}
                {post.state === 'published' && publishRight ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setEditing(post);
                    }}
                  >
                    {t('ops.statusAdmin.posts.postUpdate')}
                  </Button>
                ) : null}
                {post.state === 'draft' && publishRight ? (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      setPublishing(post);
                    }}
                  >
                    {t('ops.statusAdmin.publish')}
                  </Button>
                ) : null}
                {post.state === 'draft' && draftRight ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setDeleting(post);
                    }}
                  >
                    {t('ops.common.delete')}
                  </Button>
                ) : null}
                {post.state === 'draft' && !publishRight ? (
                  <span className="text-xs text-muted-foreground">
                    {t('ops.statusAdmin.leadPublishes')}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage ? (
        <div>
          <Button
            disabled={list.isFetchingNextPage}
            onClick={() => {
              void list.fetchNextPage();
            }}
          >
            {t('ops.common.loadMore')}
          </Button>
        </div>
      ) : null}
      {editing !== null ? (
        <PostSheet
          key={editing === 'new' ? 'new' : editing.id}
          post={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      ) : null}
      {templating ? (
        <TemplateSheet
          onClose={() => {
            setTemplating(false);
          }}
        />
      ) : null}
      {publishing ? (
        <PublishPostDialog
          post={publishing}
          onClose={() => {
            setPublishing(null);
          }}
        />
      ) : null}
      {deleting ? (
        <DeletePostDialog
          post={deleting}
          onClose={() => {
            setDeleting(null);
          }}
        />
      ) : null}
    </section>
  );
}

function PostSheet({ post, onClose }: { post: StatusPostStaff | null; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const base = useId();
  const components = useStatusComponents();
  const [title, setTitle] = useState(post?.title ?? '');
  const [body, setBody] = useState(post?.body ?? '');
  const [phase, setPhase] = useState<StatusPostPhase>(post?.phase ?? 'investigating');
  const [impact, setImpact] = useState<StatusPostImpact>(post?.impact ?? 'minor');
  const [componentIds, setComponentIds] = useState<string[]>(post?.componentIds ?? []);
  // The link is chosen when the draft is created; an existing post keeps the one it has.
  const [incidentId, setIncidentId] = useState('');
  const incidents = useIncidentList({ open: true });
  const openIncidents = incidents.data?.pages.flatMap((page) => page.items) ?? [];
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const touch = () => {
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: () => {
      const fields = { title: title.trim(), body: body.trim(), phase, impact, componentIds };
      return post === null
        ? api.createStatusPost({ ...fields, incidentId: incidentId === '' ? null : incidentId })
        : api.updateStatusPost(post.id, fields);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: opsKeys(userId).statusPostsAll });
      toast(t('ops.common.saved'));
      onClose();
    },
    onError: (e) => {
      setSummary(describeOpsError(e, t).message);
    },
  });

  const submit = () => {
    const next: Record<string, string> = {};
    if (title.trim() === '') next.title = t('ops.common.required');
    if (body.trim() === '') next.body = t('ops.common.required');
    setErrors(next);
    setSummary(null);
    if (Object.keys(next).length === 0) save.mutate();
  };

  return (
    <EntitySheet
      open
      onClose={onClose}
      title={post ? post.title : t('ops.statusAdmin.posts.add')}
      description={
        post?.state === 'published'
          ? t('ops.statusAdmin.posts.editPublishedNote')
          : t('ops.statusAdmin.posts.sheetDescription')
      }
      dirty={dirty}
      pending={save.isPending}
      formId={`${base}-form`}
      error={summary}
    >
      <form
        id={`${base}-form`}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3"
      >
        <FormField
          id={`${base}-title`}
          label={t('ops.statusAdmin.posts.titleLabel')}
          {...(errors.title ? { error: errors.title } : {})}
        >
          <Input
            id={`${base}-title`}
            value={title}
            maxLength={200}
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={errors.title ? `${base}-title-error` : undefined}
            onChange={(e) => {
              setTitle(e.target.value);
              touch();
            }}
          />
        </FormField>
        <FormField
          id={`${base}-body`}
          label={t('ops.statusAdmin.posts.bodyLabel')}
          hint={t('ops.statusAdmin.posts.bodyHint')}
          {...(errors.body ? { error: errors.body } : {})}
        >
          <Textarea
            id={`${base}-body`}
            rows={5}
            maxLength={5000}
            value={body}
            aria-invalid={errors.body ? true : undefined}
            aria-describedby={`${base}-body-hint${errors.body ? ` ${base}-body-error` : ''}`}
            onChange={(e) => {
              setBody(e.target.value);
              touch();
            }}
          />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField id={`${base}-phase`} label={t('ops.statusAdmin.posts.phase')}>
            <Select
              id={`${base}-phase`}
              value={phase}
              onChange={(e) => {
                setPhase(e.target.value as StatusPostPhase);
                touch();
              }}
            >
              {STATUS_POST_PHASES.map((value) => (
                <option key={value} value={value}>
                  {t(`ops.status.phase.${value}`)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField id={`${base}-impact`} label={t('ops.statusAdmin.posts.impact')}>
            <Select
              id={`${base}-impact`}
              value={impact}
              onChange={(e) => {
                setImpact(e.target.value as StatusPostImpact);
                touch();
              }}
            >
              {STATUS_POST_IMPACTS.map((value) => (
                <option key={value} value={value}>
                  {t(`ops.status.impact.${value}`)}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
        <ComponentPicker
          id={`${base}-components`}
          legend={t('ops.statusAdmin.affected')}
          components={components.data?.items ?? []}
          value={componentIds}
          onChange={(next) => {
            setComponentIds(next);
            touch();
          }}
        />
        {componentIds.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('ops.statusAdmin.posts.noComponentHint')}
          </p>
        ) : null}
        {post === null ? (
          <FormField
            id={`${base}-incident`}
            label={t('ops.statusAdmin.posts.incidentOptional')}
            hint={t('ops.statusAdmin.posts.incidentHint')}
          >
            <Select
              id={`${base}-incident`}
              value={incidentId}
              aria-describedby={`${base}-incident-hint`}
              onChange={(e) => {
                setIncidentId(e.target.value);
                touch();
              }}
            >
              <option value="">{t('ops.statusAdmin.posts.noIncident')}</option>
              {openIncidents.map((incident) => (
                <option key={incident.id} value={incident.id}>
                  {incident.key} · {incident.title}
                </option>
              ))}
            </Select>
          </FormField>
        ) : null}
      </form>
    </EntitySheet>
  );
}

/** A draft from the template: the wording is the template's, never the incident's title or cause. */
function TemplateSheet({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const base = useId();
  const incidents = useIncidentList({ open: true });
  const components = useStatusComponents();
  const [incidentId, setIncidentId] = useState('');
  const [componentIds, setComponentIds] = useState<string[]>([]);
  const [phase, setPhase] = useState<StatusPostPhase>('investigating');
  const [impact, setImpact] = useState<StatusPostImpact>('minor');
  const [language, setLanguage] = useState<StatusLocale>(locale === 'th' ? 'th' : 'en');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const touch = () => {
    setDirty(true);
  };
  const open = incidents.data?.pages.flatMap((page) => page.items) ?? [];

  const save = useMutation({
    mutationFn: () =>
      api.draftStatusPostFromIncident({
        incidentId,
        componentIds,
        phase,
        impact,
        locale: language,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: opsKeys(userId).statusPostsAll });
      toast(t('ops.statusAdmin.posts.draftCreated'));
      onClose();
    },
    onError: (e) => {
      setSummary(describeOpsError(e, t).message);
    },
  });

  const submit = () => {
    const next: Record<string, string> = {};
    if (incidentId === '') next.incident = t('ops.common.required');
    if (componentIds.length === 0) next.components = t('ops.statusAdmin.posts.pickComponent');
    setErrors(next);
    setSummary(null);
    if (Object.keys(next).length === 0) save.mutate();
  };

  return (
    <EntitySheet
      open
      onClose={onClose}
      title={t('ops.statusAdmin.posts.fromIncident')}
      description={t('ops.statusAdmin.posts.templateDescription')}
      dirty={dirty}
      pending={save.isPending}
      formId={`${base}-form`}
      error={summary}
      submitLabel={t('ops.statusAdmin.posts.createDraft')}
    >
      <form
        id={`${base}-form`}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3"
      >
        <FormField
          id={`${base}-incident`}
          label={t('ops.statusAdmin.posts.incident')}
          {...(errors.incident ? { error: errors.incident } : {})}
        >
          <Select
            id={`${base}-incident`}
            value={incidentId}
            aria-invalid={errors.incident ? true : undefined}
            aria-describedby={errors.incident ? `${base}-incident-error` : undefined}
            onChange={(e) => {
              setIncidentId(e.target.value);
              touch();
            }}
          >
            <option value="">{t('ops.incidents.create.choose')}</option>
            {open.map((incident) => (
              <option key={incident.id} value={incident.id}>
                {incident.key} · {incident.title}
              </option>
            ))}
          </Select>
        </FormField>
        <ComponentPicker
          id={`${base}-components`}
          legend={t('ops.statusAdmin.affected')}
          components={components.data?.items ?? []}
          value={componentIds}
          onChange={(next) => {
            setComponentIds(next);
            touch();
          }}
          error={errors.components}
        />
        <div className="grid grid-cols-3 gap-3">
          <FormField id={`${base}-phase`} label={t('ops.statusAdmin.posts.phase')}>
            <Select
              id={`${base}-phase`}
              value={phase}
              onChange={(e) => {
                setPhase(e.target.value as StatusPostPhase);
                touch();
              }}
            >
              {STATUS_POST_PHASES.map((value) => (
                <option key={value} value={value}>
                  {t(`ops.status.phase.${value}`)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField id={`${base}-impact`} label={t('ops.statusAdmin.posts.impact')}>
            <Select
              id={`${base}-impact`}
              value={impact}
              onChange={(e) => {
                setImpact(e.target.value as StatusPostImpact);
                touch();
              }}
            >
              {STATUS_POST_IMPACTS.map((value) => (
                <option key={value} value={value}>
                  {t(`ops.status.impact.${value}`)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField id={`${base}-locale`} label={t('ops.statusAdmin.posts.language')}>
            <Select
              id={`${base}-locale`}
              value={language}
              onChange={(e) => {
                setLanguage(e.target.value as StatusLocale);
                touch();
              }}
            >
              {STATUS_LOCALES.map((value) => (
                <option key={value} value={value}>
                  {value === 'th' ? 'ไทย' : 'English'}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      </form>
    </EntitySheet>
  );
}

function PublishPostDialog({ post, onClose }: { post: StatusPostStaff; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const subscribers = useStatusSubscribers(true);
  const [error, setError] = useState<string | null>(null);
  const publish = useMutation({
    mutationFn: () => api.publishStatusPost(post.id),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: opsKeys(userId).statusPostsAll });
      toast(t('ops.statusAdmin.posts.published', { count: result.subscribers }));
      onClose();
    },
    onError: (e) => {
      setError(describeOpsError(e, t).message);
    },
  });
  return (
    <PublishDialog
      title={t('ops.statusAdmin.posts.publishTitle')}
      description={`${
        subscribers.data
          ? t('ops.statusAdmin.publishBody', { count: subscribers.data.confirmed })
          : t('ops.statusAdmin.publishBodyUnknown')
      }${post.componentIds.length === 0 ? ` ${t('ops.statusAdmin.posts.publishNoComponent')}` : ''}`}
      heading={post.title}
      body={post.body}
      confirmLabel={t('ops.statusAdmin.publish')}
      onConfirm={() => {
        publish.mutate();
      }}
      onClose={onClose}
      pending={publish.isPending}
      error={error}
    />
  );
}

function DeletePostDialog({ post, onClose }: { post: StatusPostStaff; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => api.deleteStatusPost(post.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: opsKeys(userId).statusPostsAll });
      toast(t('ops.common.deleted'));
      onClose();
    },
    onError: (e) => {
      setError(describeOpsError(e, t).message);
    },
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('ops.statusAdmin.posts.deleteTitle', { title: post.title })}
      description={t('ops.statusAdmin.posts.deleteBody')}
      confirmLabel={t('ops.common.delete')}
      onConfirm={() => {
        remove.mutate();
      }}
      pending={remove.isPending}
      error={error}
    />
  );
}
