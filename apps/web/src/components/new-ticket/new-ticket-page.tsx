'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MANUAL_CHANNELS,
  TICKET_PRIORITIES,
  type CreateManualTicket,
  type ManualChannel,
  type SimilarTickets,
  type TicketPriority,
} from '@watchtower/shared';
import { Button, Input, SegmentedControl, Select, Textarea, toast } from '@watchtower/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { AccessDenied, PageHeader } from '@/components/admin/admin-page';
import {
  AttachmentDropZone,
  AttachmentPicker,
  useAttachmentUpload,
} from '@/components/attachments';
import { AppLink } from '@/components/app-link';
import { describedBy, FormField } from '@/components/portal/form-field';
import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { useSession, useUserId } from '@/lib/auth/session';
import { describeError } from '@/lib/admin/errors';
import { severityOf } from '@/lib/tickets/model';
import { withSelectedTicket } from '@/lib/tickets/selection';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The subject must be this long before similar tickets are looked up. */
const SIMILAR_MIN_LENGTH = 3;
/** Wait this long after the last keystroke before looking. */
const SIMILAR_DEBOUNCE_MS = 400;

type ContactMode = 'existing' | 'new';
type OrgMode = 'existing' | 'new';
type Field = 'org' | 'orgName' | 'contact' | 'email' | 'name' | 'subject' | 'body';
/** "Let the system pick the priority" (the field is left out of the request). */
const DEFAULT_PRIORITY = '';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return debounced;
}

/**
 * File a ticket by hand (T-136): a phone call, a visit, a chat that is not connected. Organization,
 * contact (existing, or new and unverified), channel, subject and what the customer said. The SLA clock
 * starts when the ticket is created. The confirmation email is on for an existing contact and off for a
 * new address, so it does not go to the wrong person. Ctrl or Cmd + Enter creates the ticket.
 */
export function NewTicketPage() {
  const { can } = useSession();
  if (!can('ticket.create') || !can('ticket.handle')) return <AccessDenied role="agent" />;
  return <NewTicketForm canCreateOrg={can('org.manage')} />;
}

function NewTicketForm({ canCreateOrg }: { canCreateOrg: boolean }) {
  const { t } = useI18n();
  const api = useApi();
  const router = useRouter();
  const userId = useUserId();
  const base = useId();
  const [orgId, setOrgId] = useState('');
  const [orgMode, setOrgMode] = useState<OrgMode>('existing');
  const [orgName, setOrgName] = useState('');
  const [priority, setPriority] = useState<TicketPriority | typeof DEFAULT_PRIORITY>(
    DEFAULT_PRIORITY,
  );
  const [contactMode, setContactMode] = useState<ContactMode>('existing');
  // A new organization has no contacts yet, so its requester is always a new contact.
  const mode: ContactMode = orgMode === 'new' ? 'new' : contactMode;
  const setMode = setContactMode;
  const [contactId, setContactId] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<ManualChannel>('phone');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [confirmation, setConfirmation] = useState<boolean | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const upload = useAttachmentUpload();
  const refs = useRef<Partial<Record<Field, HTMLElement | null>>>({});

  const orgs = useQuery({
    queryKey: ['user', userId, 'new-ticket', 'orgs'],
    queryFn: ({ signal }) => api.orgs({ status: 'active', limit: 200 }, signal),
  });
  const contacts = useQuery({
    queryKey: ['user', userId, 'new-ticket', 'contacts', orgId],
    queryFn: ({ signal }) => api.contacts(orgId, signal),
    enabled: orgId !== '',
  });

  // A new address defaults to "do not send"; a known contact to "send". Until the person decides, follow it.
  const sendConfirmation = confirmation ?? mode === 'existing';

  const typedSubject = useDebounced(subject.trim(), SIMILAR_DEBOUNCE_MS);
  const similar = useQuery({
    queryKey: ['user', userId, 'new-ticket', 'similar', orgId, contactId, typedSubject],
    queryFn: ({ signal }): Promise<SimilarTickets> =>
      api.similarTickets(
        {
          orgId,
          subject: typedSubject,
          ...(mode === 'existing' && contactId !== '' ? { requesterContactId: contactId } : {}),
        },
        signal,
      ),
    enabled: orgId !== '' && typedSubject.length >= SIMILAR_MIN_LENGTH,
  });

  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: async (payload: Omit<CreateManualTicket, 'orgId'> & { orgId?: string }) => {
      let target = payload.orgId;
      if (target === undefined) {
        // A new organization first. If the ticket then fails, the organization stays chosen, so a
        // second try does not make a duplicate.
        const org = await api.createOrg({ name: orgName.trim() });
        target = org.id;
        setOrgId(org.id);
        setOrgMode('existing');
        setContactMode('new');
        void queryClient.invalidateQueries({ queryKey: ['user', userId, 'new-ticket', 'orgs'] });
      }
      return api.createManualTicket({ ...payload, orgId: target });
    },
    onSuccess: (result) => {
      toast(
        `${t('newTicket.created', { key: result.ticket.key })}. ${t(`newTicket.confirmation.${result.confirmation.status}`)}`,
      );
      router.push(withSelectedTicket('', result.ticket.key));
    },
    onError: (error) => {
      setFailure(describeError(error, t).message);
    },
  });

  const submit = (): void => {
    if (create.isPending) return;
    if (upload.busy) {
      setFailure(t('attachments.waitForUploads'));
      return;
    }
    const next: Partial<Record<Field, string>> = {};
    const required = t('newTicket.required');
    if (orgMode === 'existing' && orgId === '') next.org = required;
    if (orgMode === 'new' && orgName.trim() === '') next.orgName = required;
    if (mode === 'existing' && contactId === '') next.contact = required;
    if (mode === 'new') {
      if (email.trim() === '') next.email = required;
      else if (!EMAIL.test(email.trim())) next.email = t('newTicket.emailInvalid');
      if (name.trim() === '') next.name = required;
    }
    if (subject.trim() === '') next.subject = required;
    if (body.trim() === '') next.body = required;
    setErrors(next);
    setFailure(null);
    const first = (['org', 'orgName', 'contact', 'email', 'name', 'subject', 'body'] as const).find(
      (field) => next[field] !== undefined,
    );
    if (first) {
      refs.current[first]?.focus();
      return;
    }
    create.mutate({
      ...(orgMode === 'existing' ? { orgId } : {}),
      ...(priority !== DEFAULT_PRIORITY ? { priority } : {}),
      channel,
      subject: subject.trim(),
      body: body.trim(),
      ...(mode === 'existing'
        ? { requesterContactId: contactId }
        : { requester: { email: email.trim(), name: name.trim() } }),
      sendConfirmation,
      ...(upload.attachmentIds.length > 0 ? { attachmentIds: upload.attachmentIds } : {}),
    });
  };

  const onSubmit = (event: { preventDefault: () => void }): void => {
    event.preventDefault();
    submit();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  };

  const invalid = (field: Field) => ({
    'aria-invalid': errors[field] ? (true as const) : undefined,
    'aria-describedby': errors[field] ? `${base}-${field}-error` : undefined,
  });
  const people = contacts.data?.items ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title={t('newTicket.title')} />
      <main id="main-content" className="min-h-0 flex-1 overflow-y-auto">
        <form
          noValidate
          onSubmit={onSubmit}
          onKeyDown={onKeyDown}
          className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4"
        >
          <p className="text-sm text-muted-foreground">{t('newTicket.intro')}</p>

          {canCreateOrg ? (
            <SegmentedControl
              aria-label={t('newTicket.orgChoice')}
              value={orgMode}
              onValueChange={(value) => {
                setOrgMode(value);
                setErrors({});
              }}
              options={[
                { value: 'existing', label: t('newTicket.orgExisting') },
                { value: 'new', label: t('newTicket.orgNew') },
              ]}
            />
          ) : null}
          {orgMode === 'existing' ? (
            <FormField
              id={`${base}-org`}
              label={t('newTicket.org')}
              {...(errors.org ? { error: errors.org } : {})}
              {...(canCreateOrg ? {} : { hint: t('newTicket.orgMissing') })}
            >
              <Select
                id={`${base}-org`}
                ref={(node) => {
                  refs.current.org = node;
                }}
                value={orgId}
                className="w-full"
                {...invalid('org')}
                aria-describedby={describedBy(
                  `${base}-org`,
                  !canCreateOrg,
                  errors.org !== undefined,
                )}
                onChange={(event) => {
                  setOrgId(event.target.value);
                  setContactId('');
                }}
              >
                <option value="">{t('newTicket.orgPick')}</option>
                {(orgs.data?.items ?? []).map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : (
            <FormField
              id={`${base}-orgname`}
              label={t('newTicket.orgName')}
              hint={t('newTicket.orgNameHint')}
              {...(errors.orgName ? { error: errors.orgName } : {})}
            >
              <Input
                id={`${base}-orgname`}
                ref={(node) => {
                  refs.current.orgName = node;
                }}
                autoComplete="off"
                maxLength={200}
                value={orgName}
                aria-invalid={errors.orgName ? true : undefined}
                aria-describedby={`${base}-orgname-hint${errors.orgName ? ` ${base}-orgname-error` : ''}`}
                onChange={(event) => {
                  setOrgName(event.target.value);
                }}
              />
            </FormField>
          )}
          {orgs.isError ? (
            <p role="alert" className="text-sm text-danger">
              {t('newTicket.loadFailed')}
            </p>
          ) : null}

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-medium">{t('newTicket.contactLegend')}</legend>
            {orgMode === 'existing' ? (
              <SegmentedControl
                aria-label={t('newTicket.contactLegend')}
                value={mode}
                onValueChange={(value) => {
                  setMode(value);
                  setConfirmation(null);
                }}
                options={[
                  { value: 'existing', label: t('newTicket.contactExisting') },
                  { value: 'new', label: t('newTicket.contactNew') },
                ]}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t('newTicket.contactNewOrg')}</p>
            )}
            {mode === 'existing' ? (
              <FormField
                id={`${base}-contact`}
                label={t('newTicket.contactPick')}
                {...(errors.contact ? { error: errors.contact } : {})}
                {...(orgId !== '' && contacts.isSuccess && people.length === 0
                  ? { hint: t('newTicket.contactNone') }
                  : {})}
              >
                <Select
                  id={`${base}-contact`}
                  ref={(node) => {
                    refs.current.contact = node;
                  }}
                  value={contactId}
                  disabled={orgId === ''}
                  className="w-full"
                  {...invalid('contact')}
                  onChange={(event) => {
                    setContactId(event.target.value);
                  }}
                >
                  <option value="">{t('newTicket.contactPick')}</option>
                  {people.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                      {person.emails[0] ? ` · ${person.emails[0]}` : ''}
                    </option>
                  ))}
                </Select>
              </FormField>
            ) : (
              <>
                <FormField
                  id={`${base}-email`}
                  label={t('newTicket.contactEmail')}
                  hint={t('newTicket.contactUnverified')}
                  {...(errors.email ? { error: errors.email } : {})}
                >
                  <Input
                    id={`${base}-email`}
                    ref={(node) => {
                      refs.current.email = node;
                    }}
                    type="email"
                    autoComplete="off"
                    value={email}
                    {...invalid('email')}
                    onChange={(event) => {
                      setEmail(event.target.value);
                    }}
                  />
                </FormField>
                <FormField
                  id={`${base}-name`}
                  label={t('newTicket.contactName')}
                  {...(errors.name ? { error: errors.name } : {})}
                >
                  <Input
                    id={`${base}-name`}
                    ref={(node) => {
                      refs.current.name = node;
                    }}
                    autoComplete="off"
                    value={name}
                    {...invalid('name')}
                    onChange={(event) => {
                      setName(event.target.value);
                    }}
                  />
                </FormField>
              </>
            )}
          </fieldset>

          <FormField id={`${base}-channel`} label={t('newTicket.channel')}>
            <Select
              id={`${base}-channel`}
              value={channel}
              className="w-full"
              onChange={(event) => {
                const next = MANUAL_CHANNELS.find((value) => value === event.target.value);
                if (next) setChannel(next);
              }}
            >
              {MANUAL_CHANNELS.map((value) => (
                <option key={value} value={value}>
                  {t(`channel.${value}`)}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField
            id={`${base}-priority`}
            label={t('newTicket.priority')}
            hint={t('newTicket.priorityHint')}
          >
            <Select
              id={`${base}-priority`}
              value={priority}
              className="w-full"
              aria-describedby={`${base}-priority-hint`}
              onChange={(event) => {
                const next = TICKET_PRIORITIES.find((value) => value === event.target.value);
                setPriority(next ?? DEFAULT_PRIORITY);
              }}
            >
              <option value={DEFAULT_PRIORITY}>{t('newTicket.priorityDefault')}</option>
              {TICKET_PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {`${value} ${t(`severity.${severityOf(value)}`)}`}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField
            id={`${base}-subject`}
            label={t('newTicket.subject')}
            {...(errors.subject ? { error: errors.subject } : {})}
          >
            <Input
              id={`${base}-subject`}
              ref={(node) => {
                refs.current.subject = node;
              }}
              maxLength={300}
              value={subject}
              {...invalid('subject')}
              onChange={(event) => {
                setSubject(event.target.value);
              }}
            />
          </FormField>

          {similar.data && similar.data.items.length > 0 ? (
            <section aria-labelledby={`${base}-similar`} className="rounded-md border p-3">
              <h2 id={`${base}-similar`} className="mb-1 text-sm font-medium">
                {t('newTicket.similarHeading')}
              </h2>
              <ul className="flex flex-col gap-1 text-sm">
                {similar.data.items.map((item) => (
                  <li key={item.id}>
                    <AppLink
                      href={withSelectedTicket('', item.key)}
                      className="underline-offset-2 hover:underline"
                      aria-label={t('newTicket.similarOpen', { key: item.key })}
                    >
                      <span className="font-mono">{item.key}</span> {item.subject}
                    </AppLink>
                    {item.sameRequester ? (
                      <span className="ml-2 text-muted-foreground">
                        {t('newTicket.similarSameRequester')}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <FormField
            id={`${base}-body`}
            label={t('newTicket.body')}
            {...(errors.body ? { error: errors.body } : {})}
          >
            <AttachmentDropZone upload={upload} disabled={create.isPending}>
              <Textarea
                id={`${base}-body`}
                ref={(node) => {
                  refs.current.body = node;
                }}
                rows={6}
                maxLength={20000}
                value={body}
                className="w-full"
                {...invalid('body')}
                onChange={(event) => {
                  setBody(event.target.value);
                }}
              />
            </AttachmentDropZone>
          </FormField>
          <AttachmentPicker upload={upload} disabled={create.isPending} />

          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={sendConfirmation}
                aria-describedby={mode === 'new' ? `${base}-confirm-hint` : undefined}
                onChange={(event) => {
                  setConfirmation(event.target.checked);
                }}
              />
              {mode === 'new' ? t('newTicket.confirmNew') : t('newTicket.confirmExisting')}
            </label>
            {mode === 'new' ? (
              <p id={`${base}-confirm-hint`} className="text-xs text-muted-foreground">
                {t('newTicket.confirmNewHint')}
              </p>
            ) : null}
          </div>

          <p className="text-xs text-muted-foreground">{t('newTicket.noReply')}</p>

          {failure ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {t('newTicket.failed')}: {failure}
            </p>
          ) : null}
          <div>
            <Button type="submit" variant="primary" disabled={create.isPending || upload.busy}>
              {create.isPending ? t('newTicket.submitting') : t('newTicket.submit')}
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}
