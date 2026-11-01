'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type Contact, emailSchema } from '@watchtower/shared';
import { Input, Textarea, toast } from '@watchtower/ui';
import { useId, useState } from 'react';

import { EntitySheet } from '@/components/admin/entity-sheet';
import { FormField } from '@/components/portal/form-field';
import { useT } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { adminKeys } from '@/lib/admin/queries';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';

/** Create or edit a contact of an organization: name, 1 to 10 addresses, LINE id, phone, role. */
export function ContactSheet({
  open,
  orgId,
  contact,
  onClose,
}: {
  open: boolean;
  orgId: string;
  contact: Contact | null;
  onClose: () => void;
}) {
  const t = useT();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const base = useId();
  const [name, setName] = useState(contact?.name ?? '');
  const [emails, setEmails] = useState((contact?.emails ?? []).join('\n'));
  const [line, setLine] = useState(contact?.lineUserId ?? '');
  const [phone, setPhone] = useState(contact?.phone ?? '');
  const [role, setRole] = useState(contact?.roleInOrg ?? '');
  const [errors, setErrors] = useState<{ name?: string; emails?: string }>({});
  const [summary, setSummary] = useState<string | null>(null);

  const list = emails
    .split(/[\n,]/u)
    .map((value) => value.trim())
    .filter(Boolean);

  const save = useMutation({
    mutationFn: () =>
      contact === null
        ? api.createContact({
            orgId,
            name: name.trim(),
            emails: list,
            ...(line.trim() ? { lineUserId: line.trim() } : {}),
            ...(phone.trim() ? { phone: phone.trim() } : {}),
            ...(role.trim() ? { roleInOrg: role.trim() } : {}),
          })
        : api.updateContact(contact.id, {
            name: name.trim(),
            emails: list,
            lineUserId: line.trim() === '' ? null : line.trim(),
            phone: phone.trim() === '' ? null : phone.trim(),
            roleInOrg: role.trim() === '' ? null : role.trim(),
          }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).contacts(orgId) });
      toast(t('admin.common.saved'));
      onClose();
    },
    onError: (error) => {
      setSummary(describeError(error, t).message);
    },
  });

  const submit = () => {
    const next: { name?: string; emails?: string } = {};
    if (name.trim() === '') next.name = t('admin.common.required');
    if (
      list.length === 0 ||
      list.length > 10 ||
      !list.every((e) => emailSchema.safeParse(e).success)
    ) {
      next.emails = t('admin.contacts.emailsInvalid');
    }
    setErrors(next);
    setSummary(null);
    if (Object.keys(next).length === 0) save.mutate();
  };

  return (
    <EntitySheet
      open={open}
      onClose={onClose}
      title={contact ? contact.name : t('admin.contacts.new')}
      description={t('admin.contacts.description')}
      dirty={
        contact === null
          ? name !== '' || emails !== ''
          : name !== contact.name || emails !== contact.emails.join('\n')
      }
      pending={save.isPending}
      formId={`${base}-form`}
      error={summary}
    >
      <form
        id={`${base}-form`}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3"
      >
        <FormField
          id={`${base}-name`}
          label={t('admin.common.name')}
          {...(errors.name ? { error: errors.name } : {})}
        >
          <Input
            id={`${base}-name`}
            value={name}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? `${base}-name-error` : undefined}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </FormField>
        <FormField
          id={`${base}-emails`}
          label={t('admin.contacts.emails')}
          {...(errors.emails ? { error: errors.emails } : {})}
        >
          <Textarea
            id={`${base}-emails`}
            rows={3}
            value={emails}
            aria-invalid={errors.emails ? true : undefined}
            aria-describedby={errors.emails ? `${base}-emails-error` : undefined}
            onChange={(event) => {
              setEmails(event.target.value);
            }}
          />
        </FormField>
        <FormField
          id={`${base}-line`}
          label={t('admin.contacts.lineId')}
          optionalLabel={t('admin.common.optional')}
        >
          <Input
            id={`${base}-line`}
            value={line}
            onChange={(event) => {
              setLine(event.target.value);
            }}
          />
        </FormField>
        <FormField
          id={`${base}-phone`}
          label={t('admin.contacts.phone')}
          optionalLabel={t('admin.common.optional')}
        >
          <Input
            id={`${base}-phone`}
            value={phone}
            onChange={(event) => {
              setPhone(event.target.value);
            }}
          />
        </FormField>
        <FormField
          id={`${base}-role`}
          label={t('admin.contacts.role')}
          optionalLabel={t('admin.common.optional')}
        >
          <Input
            id={`${base}-role`}
            value={role}
            onChange={(event) => {
              setRole(event.target.value);
            }}
          />
        </FormField>
      </form>
    </EntitySheet>
  );
}
