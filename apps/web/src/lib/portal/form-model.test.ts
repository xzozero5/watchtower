import { describe, expect, it } from 'vitest';

import {
  EMPTY_FORM,
  parseRequestIds,
  validateForm,
  withoutError,
  type FormValues,
} from './form-model';

const valid: FormValues = {
  ...EMPTY_FORM,
  name: ' Dana Demo ',
  email: ' Ada@Example.COM ',
  category: 'api_error',
  description: ' The export fails with a 500 ',
};

describe('validateForm', () => {
  it('builds the payload the api expects: trimmed, lower-cased email, no empty optionals', () => {
    const result = validateForm(valid, 'en');
    expect(result).toEqual({
      ok: true,
      payload: {
        email: 'ada@example.com',
        name: 'Dana Demo',
        category: 'api_error',
        description: 'The export fails with a 500',
        locale: 'en',
        website: '',
      },
    });
  });

  it('sends the optional fields when filled, and the page language', () => {
    const result = validateForm(
      {
        ...valid,
        organization: 'Acme',
        urgency: 'everything_down',
        subject: 'Export fails',
        requestIds: 'req_1\nreq_2, req_1  req_3',
      },
      'th',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toMatchObject({
      organization: 'Acme',
      urgency: 'everything_down',
      subject: 'Export fails',
      affectedRequestIds: ['req_1', 'req_2', 'req_3'],
      locale: 'th',
    });
  });

  it('keeps the honeypot value in the payload so the api can refuse a bot', () => {
    const result = validateForm({ ...valid, website: 'https://spam.example' }, 'en');
    expect(result.ok && result.payload.website).toBe('https://spam.example');
  });

  it('never adds attachments or a verification proof of its own', () => {
    const result = validateForm(valid, 'en');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.payload)).not.toContain('attachments');
    expect(Object.keys(result.payload)).not.toContain('verification');
  });

  it('names every empty required field', () => {
    const result = validateForm(EMPTY_FORM, 'en');
    expect(result).toEqual({
      ok: false,
      errors: {
        name: 'portal.form.errors.nameRequired',
        email: 'portal.form.errors.emailRequired',
        category: 'portal.form.errors.categoryRequired',
        description: 'portal.form.errors.descriptionRequired',
      },
    });
  });

  it('treats whitespace as empty', () => {
    const result = validateForm({ ...valid, name: '   ', description: '\n\t' }, 'en');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.name).toBe('portal.form.errors.nameRequired');
    expect(result.errors.description).toBe('portal.form.errors.descriptionRequired');
  });

  it('rejects a malformed email and over-long text', () => {
    const result = validateForm(
      {
        ...valid,
        email: 'not-an-email',
        name: 'x'.repeat(201),
        organization: 'y'.repeat(201),
        subject: 'z'.repeat(151),
        description: 'd'.repeat(10_001),
      },
      'en',
    );
    expect(result).toEqual({
      ok: false,
      errors: {
        email: 'portal.form.errors.emailInvalid',
        name: 'portal.form.errors.nameTooLong',
        organization: 'portal.form.errors.organizationTooLong',
        subject: 'portal.form.errors.subjectTooLong',
        description: 'portal.form.errors.descriptionTooLong',
      },
    });
  });

  it('rejects request ids with odd characters and more than ten', () => {
    const odd = validateForm({ ...valid, requestIds: 'ok_1\n<script>' }, 'en');
    expect(!odd.ok && odd.errors.requestIds).toBe('portal.form.errors.requestIdsInvalid');

    const many = validateForm(
      { ...valid, requestIds: Array.from({ length: 11 }, (_, i) => `req_${String(i)}`).join('\n') },
      'en',
    );
    expect(!many.ok && many.errors.requestIds).toBe('portal.form.errors.requestIdsTooMany');
  });
});

describe('parseRequestIds', () => {
  it('splits on lines, commas and spaces, and drops blanks and repeats', () => {
    expect(parseRequestIds('')).toEqual([]);
    expect(parseRequestIds(' a\n\nb, c  a ')).toEqual(['a', 'b', 'c']);
  });
});

describe('withoutError', () => {
  it('drops the error of the edited field only', () => {
    expect(
      withoutError(
        { name: 'portal.form.errors.nameRequired', email: 'portal.form.errors.emailInvalid' },
        'name',
      ),
    ).toEqual({ email: 'portal.form.errors.emailInvalid' });
  });
});
