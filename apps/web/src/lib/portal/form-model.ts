import {
  PORTAL_CATEGORIES,
  PORTAL_URGENCIES,
  portalSubmitSchema,
  type PortalCategory,
  type PortalLocale,
  type PortalSubmit,
  type PortalUrgency,
} from '@watchtower/shared';

import type { MessageKey } from '@/i18n';

/** What the submit form holds while someone types. Everything is text until it is validated. */
export interface FormValues {
  name: string;
  email: string;
  organization: string;
  category: PortalCategory | '';
  urgency: PortalUrgency | '';
  subject: string;
  description: string;
  /** One request id per line (commas and spaces also separate them). */
  requestIds: string;
  /** The honeypot. A person never sees the field, so it stays empty. */
  website: string;
}

export const EMPTY_FORM: FormValues = {
  name: '',
  email: '',
  organization: '',
  category: '',
  urgency: '',
  subject: '',
  description: '',
  requestIds: '',
  website: '',
};

/** Fields that can show an error, in the order they appear on the page. */
export const FORM_FIELDS = [
  'name',
  'email',
  'organization',
  'category',
  'subject',
  'description',
  'requestIds',
] as const;
export type FormField = (typeof FORM_FIELDS)[number];

export function isFormField(value: string): value is FormField {
  return FORM_FIELDS.some((field) => field === value);
}

export type FormErrors = Partial<Record<FormField, MessageKey>>;

/** The body of `POST /v1/portal/tickets` except the human-verification proof. */
export type SubmitPayload = Omit<PortalSubmit, 'verification'>;

export type ValidationResult =
  { ok: true; payload: SubmitPayload } | { ok: false; errors: FormErrors };

/** The request ids typed into the textarea, without blanks and without repeats. */
export function parseRequestIds(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter((part) => part !== ''))];
}

export function isPortalCategory(value: string): value is PortalCategory {
  return PORTAL_CATEGORIES.some((category) => category === value);
}

export function isPortalUrgency(value: string): value is PortalUrgency {
  return PORTAL_URGENCIES.some((urgency) => urgency === value);
}

const requestSchema = portalSubmitSchema.omit({ verification: true });

function errorKey(field: FormField, code: string, depth: number): MessageKey {
  const tooLong = code === 'too_big';
  switch (field) {
    case 'name':
      return tooLong ? 'portal.form.errors.nameTooLong' : 'portal.form.errors.nameRequired';
    case 'email':
      return 'portal.form.errors.emailInvalid';
    case 'organization':
      return 'portal.form.errors.organizationTooLong';
    case 'category':
      return 'portal.form.errors.categoryRequired';
    case 'subject':
      return 'portal.form.errors.subjectTooLong';
    case 'description':
      return tooLong
        ? 'portal.form.errors.descriptionTooLong'
        : 'portal.form.errors.descriptionRequired';
    case 'requestIds':
      return tooLong && depth === 1
        ? 'portal.form.errors.requestIdsTooMany'
        : 'portal.form.errors.requestIdsInvalid';
  }
}

function fieldOfIssue(path: readonly PropertyKey[]): FormField | null {
  const first = path[0];
  if (first === 'affectedRequestIds') return 'requestIds';
  return FORM_FIELDS.find((field) => field === first) ?? null;
}

/**
 * Checks the form with the same Zod schema the api uses, so a message here means the api would
 * refuse the request too. Empty required fields get their own "enter ..." message first.
 */
export function validateForm(values: FormValues, locale: PortalLocale): ValidationResult {
  const errors: FormErrors = {};
  if (values.name.trim() === '') errors.name = 'portal.form.errors.nameRequired';
  if (values.email.trim() === '') errors.email = 'portal.form.errors.emailRequired';
  if (values.category === '') errors.category = 'portal.form.errors.categoryRequired';
  if (values.description.trim() === '') {
    errors.description = 'portal.form.errors.descriptionRequired';
  }

  const requestIds = parseRequestIds(values.requestIds);
  const candidate = {
    email: values.email,
    name: values.name,
    ...(values.organization.trim() === '' ? {} : { organization: values.organization }),
    category: values.category,
    ...(values.urgency === '' ? {} : { urgency: values.urgency }),
    ...(values.subject.trim() === '' ? {} : { subject: values.subject }),
    description: values.description,
    ...(requestIds.length === 0 ? {} : { affectedRequestIds: requestIds }),
    locale,
    website: values.website,
  };

  const parsed = requestSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = fieldOfIssue(issue.path);
      if (field !== null && errors[field] === undefined) {
        errors[field] = errorKey(field, issue.code, issue.path.length);
      }
    }
  }
  if (Object.keys(errors).length > 0 || !parsed.success) {
    // An issue on a field this form has no place for would otherwise pass silently.
    return { ok: false, errors };
  }
  return { ok: true, payload: parsed.data };
}

/** The errors without the one of `field`, once the person edits that field. */
export function withoutError(errors: FormErrors, field: FormField): FormErrors {
  const next: FormErrors = {};
  for (const name of FORM_FIELDS) {
    const key = errors[name];
    if (name !== field && key !== undefined) next[name] = key;
  }
  return next;
}
