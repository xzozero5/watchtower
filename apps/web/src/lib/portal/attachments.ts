import {
  PORTAL_ATTACHMENT_MAX_BYTES,
  PORTAL_ATTACHMENT_MAX_FILES,
  PORTAL_ATTACHMENT_MAX_TOTAL_BYTES,
  checkPortalAttachments,
  type PortalAttachmentProblem,
} from '@watchtower/shared';

import type { MessageKey } from '@/i18n';

/**
 * The files a person has picked for a portal request, and the checks the page can make before
 * sending (the api repeats them and also looks at the file's bytes). A file that fails a check is
 * not added; the person is told which one and why.
 */

export interface AttachmentIssue {
  readonly key: MessageKey;
  readonly values: Record<string, string | number>;
}

const MB = 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

const PROBLEM_KEYS: Record<PortalAttachmentProblem, MessageKey> = {
  too_many: 'portal.attachments.errors.tooMany',
  empty: 'portal.attachments.errors.empty',
  too_large: 'portal.attachments.errors.tooLarge',
  type_not_allowed: 'portal.attachments.errors.typeNotAllowed',
  total_too_large: 'portal.attachments.errors.totalTooLarge',
};

function issue(problem: PortalAttachmentProblem, name: string): AttachmentIssue {
  return {
    key: PROBLEM_KEYS[problem],
    values: {
      name,
      count: PORTAL_ATTACHMENT_MAX_FILES,
      size: PORTAL_ATTACHMENT_MAX_BYTES / MB,
      total: PORTAL_ATTACHMENT_MAX_TOTAL_BYTES / MB,
    },
  };
}

const sameFile = (a: File, b: File) =>
  a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

/** Adds the files that pass; the rest become issues. The same file twice is added once, silently. */
export function addAttachments(
  current: readonly File[],
  incoming: readonly File[],
): { files: File[]; issues: AttachmentIssue[] } {
  const files = [...current];
  const issues: AttachmentIssue[] = [];
  for (const file of incoming) {
    if (files.some((existing) => sameFile(existing, file))) continue;
    const alone = checkPortalAttachments([file]);
    if (alone !== null) {
      issues.push(issue(alone.problem, file.name));
      continue;
    }
    const together = checkPortalAttachments([...files, file]);
    if (together !== null) {
      issues.push(issue(together.problem, file.name));
      continue;
    }
    files.push(file);
  }
  return { files, issues };
}

export function removeAttachment(current: readonly File[], index: number): File[] {
  return current.filter((_, position) => position !== index);
}
