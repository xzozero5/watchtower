'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateShiftNote, NoteAudience, ShiftNote } from '@watchtower/shared';
import {
  Button,
  EmptyState,
  Input,
  SegmentedControl,
  Select,
  Textarea,
  toast,
} from '@watchtower/ui';
import { StickyNote } from 'lucide-react';
import { useId, useState } from 'react';

import { LoadError, RequirePermission } from '@/components/admin/admin-page';
import {
  AttachmentDropZone,
  AttachmentGallery,
  AttachmentPicker,
  useAttachmentUpload,
} from '@/components/attachments';
import { FormField } from '@/components/portal/form-field';
import { ShiftSection, ShiftSkeleton, useShiftFormat } from '@/components/shift/shift-bits';
import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { describeShiftError, localInputToIso } from '@/lib/shifts/model';
import { shiftKeys, useAssignees, useShiftNotes } from '@/lib/shifts/queries';

export function NotesPage() {
  return (
    <RequirePermission permission="shift.note.write" role="lead">
      <NotesBody />
    </RequirePermission>
  );
}

function NotesBody() {
  const { t } = useI18n();
  const [box, setBox] = useState<'inbox' | 'sent'>('inbox');
  const [unread, setUnread] = useState(false);
  const notes = useShiftNotes(box, box === 'inbox' && unread);
  const items = notes.data?.pages.flatMap((page) => page.items) ?? [];
  const unreadCount = notes.data?.pages[0]?.unreadCount ?? 0;
  return (
    <>
      <Compose />
      <ShiftSection id="notes-list" title={t('shift.notes.title')} tone="green" icon={StickyNote}>
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            aria-label={t('shift.notes.boxLabel')}
            value={box}
            onValueChange={setBox}
            options={[
              { value: 'inbox', label: t('shift.notes.inbox') },
              { value: 'sent', label: t('shift.notes.sent') },
            ]}
          />
          {box === 'inbox' ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={unread}
                onChange={(event) => {
                  setUnread(event.target.checked);
                }}
                className="size-4"
              />
              {t('shift.notes.unreadOnly')}
            </label>
          ) : null}
          {unreadCount > 0 ? (
            <span className="tabular rounded-full bg-primary-subtle px-2 text-xs">
              {t('shift.notes.unreadCount', { count: unreadCount })}
            </span>
          ) : null}
        </div>
        {notes.isPending ? (
          <ShiftSkeleton rows={3} />
        ) : notes.isError ? (
          <LoadError message={t('shift.common.loadError')} onRetry={() => void notes.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<StickyNote />}
            title={t(
              box === 'sent'
                ? 'shift.notes.emptySent'
                : unread
                  ? 'shift.notes.emptyUnread'
                  : 'shift.notes.empty',
            )}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((note) => (
              <NoteCard key={note.id} note={note} box={box} />
            ))}
          </ul>
        )}
        {notes.hasNextPage ? (
          <div>
            <Button
              disabled={notes.isFetchingNextPage}
              onClick={() => {
                void notes.fetchNextPage();
              }}
            >
              {t('shift.notes.loadMore')}
            </Button>
          </div>
        ) : null}
      </ShiftSection>
    </>
  );
}

function NoteCard({ note, box }: { note: ShiftNote; box: 'inbox' | 'sent' }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const format = useShiftFormat(undefined);
  const read = useMutation({
    mutationFn: () => api.markShiftNoteRead(note.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: shiftKeys(userId).all });
    },
    onError: () => {
      toast(t('shift.notes.markFailed'));
    },
  });
  const to =
    note.audience === 'person' && note.toUser
      ? t('shift.notes.toLine', { name: note.toUser.name })
      : note.audience === 'datetime' && note.deliverAt
        ? t('shift.notes.toDatetimeLine', { at: format.dateTime(note.deliverAt) })
        : t('shift.notes.toNextLine');
  return (
    <li
      data-unread={box === 'inbox' && note.readAt === null ? 'true' : undefined}
      className="flex flex-wrap items-start justify-between gap-2 rounded-inner bg-surface px-3.5 py-2.5 shadow-card text-sm"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">
          {t('shift.notes.from', { name: note.author.name })} · {to} ·{' '}
          {format.dateTime(note.createdAt)}
        </p>
        <p className="whitespace-pre-wrap">{note.body}</p>
        <AttachmentGallery attachments={note.attachments} className="mt-2" />
      </div>
      {box === 'inbox' ? (
        note.readAt === null ? (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">{t('shift.notes.unread')}</span>
            <Button
              size="sm"
              disabled={read.isPending}
              onClick={() => {
                read.mutate();
              }}
            >
              {t('shift.notes.markRead')}
            </Button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">{t('shift.notes.read')}</span>
        )
      ) : null}
    </li>
  );
}

function Compose() {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const selfId = useUserId();
  const queryClient = useQueryClient();
  const base = useId();
  const assignees = useAssignees();
  const [audience, setAudience] = useState<NoteAudience>('next_shift');
  const [toUserId, setToUserId] = useState('');
  const [deliverAt, setDeliverAt] = useState('');
  const [body, setBody] = useState('');
  const [errors, setErrors] = useState<{ body?: boolean; person?: boolean; at?: boolean }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const upload = useAttachmentUpload();
  const people = (assignees.data?.assignees ?? []).filter((person) => person.id !== selfId);

  const send = useMutation({
    mutationFn: (payload: CreateShiftNote) => api.createShiftNote(payload),
    onSuccess: async () => {
      setBody('');
      upload.clear();
      setFailure(null);
      await queryClient.invalidateQueries({ queryKey: shiftKeys(userId).notesAll });
      toast(t('shift.notes.sentDone'));
    },
    onError: (error) => {
      setFailure(describeShiftError(error, t).message);
    },
  });

  return (
    <ShiftSection
      id="notes-compose"
      title={t('shift.notes.composeHeading')}
      tone="teal"
      icon={StickyNote}
    >
      <form
        noValidate
        className="flex max-w-xl flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const iso = localInputToIso(deliverAt);
          const next = {
            body: body.trim() === '',
            person: audience === 'person' && toUserId === '',
            at: audience === 'datetime' && iso === null,
          };
          setErrors(next);
          if (next.body || next.person || next.at) return;
          if (upload.busy) {
            setFailure(t('attachments.waitForUploads'));
            return;
          }
          const payload: CreateShiftNote = {
            audience,
            body: body.trim(),
            ...(audience === 'person' ? { toUserId } : {}),
            ...(audience === 'datetime' && iso ? { deliverAt: iso } : {}),
            ...(upload.attachmentIds.length > 0 ? { attachmentIds: upload.attachmentIds } : {}),
          };
          send.mutate(payload);
        }}
      >
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t('shift.notes.audience')}</span>
          <SegmentedControl
            aria-label={t('shift.notes.audience')}
            value={audience}
            onValueChange={setAudience}
            options={[
              { value: 'next_shift', label: t('shift.notes.nextShift') },
              { value: 'person', label: t('shift.notes.person') },
              { value: 'datetime', label: t('shift.notes.datetime') },
            ]}
          />
        </div>
        {audience === 'person' ? (
          <FormField
            id={`${base}-to`}
            label={t('shift.notes.toPerson')}
            {...(errors.person ? { error: t('shift.common.required') } : {})}
          >
            <Select
              id={`${base}-to`}
              value={toUserId}
              aria-invalid={errors.person ? true : undefined}
              aria-describedby={errors.person ? `${base}-to-error` : undefined}
              className="w-full"
              onChange={(event) => {
                setToUserId(event.target.value);
              }}
            >
              <option value="">{t('shift.notes.pickPerson')}</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </FormField>
        ) : null}
        {audience === 'datetime' ? (
          <FormField
            id={`${base}-at`}
            label={t('shift.notes.deliverAt')}
            {...(errors.at ? { error: t('shift.common.required') } : {})}
          >
            <Input
              id={`${base}-at`}
              type="datetime-local"
              value={deliverAt}
              aria-invalid={errors.at ? true : undefined}
              aria-describedby={errors.at ? `${base}-at-error` : undefined}
              onChange={(event) => {
                setDeliverAt(event.target.value);
              }}
            />
          </FormField>
        ) : null}
        <FormField
          id={`${base}-body`}
          label={t('shift.notes.body')}
          {...(errors.body ? { error: t('shift.common.required') } : {})}
        >
          <AttachmentDropZone upload={upload} disabled={send.isPending}>
            <Textarea
              id={`${base}-body`}
              value={body}
              maxLength={2000}
              aria-invalid={errors.body ? true : undefined}
              aria-describedby={errors.body ? `${base}-body-error` : undefined}
              className="w-full"
              onChange={(event) => {
                setBody(event.target.value);
              }}
            />
          </AttachmentDropZone>
        </FormField>
        <AttachmentPicker upload={upload} disabled={send.isPending} />
        {failure ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {failure}
          </p>
        ) : null}
        <div>
          <Button type="submit" variant="primary" disabled={send.isPending || upload.busy}>
            {send.isPending ? t('shift.common.saving') : t('shift.notes.send')}
          </Button>
        </div>
      </form>
    </ShiftSection>
  );
}
