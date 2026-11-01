import type { Translate } from '@/i18n';
import { isApiError } from '@/lib/api/errors';

export type ErrorKind = 'forbidden' | 'conflict' | 'invalid' | 'network' | 'other';

export interface ErrorView {
  kind: ErrorKind;
  /** Plain words for the person. Never a stack trace and never raw JSON. */
  message: string;
  /** The api's own sentence, for a 409 or a 400 where it explains what to change. */
  fromApi: boolean;
}

/**
 * Turns a failed request into one sentence. A 403 says the person lacks the permission, a 409 and a
 * 400 show the api's explanation (it says what to change), anything else is generic. Code that
 * needs the HTTP status asks `error.status` itself.
 */
export function describeError(error: unknown, t: Translate): ErrorView {
  if (isApiError(error)) {
    if (error.status === 403) {
      return { kind: 'forbidden', message: t('admin.common.forbidden'), fromApi: false };
    }
    if (error.status === 409 && error.message) {
      return { kind: 'conflict', message: error.message, fromApi: true };
    }
    if ((error.status === 400 || error.code === 'validation_failed') && error.message) {
      return { kind: 'invalid', message: error.message, fromApi: true };
    }
    if (error.code === 'network') {
      return { kind: 'network', message: t('admin.common.networkError'), fromApi: false };
    }
  }
  return { kind: 'other', message: t('admin.common.genericError'), fromApi: false };
}
