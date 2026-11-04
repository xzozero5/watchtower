import { gmail } from '@watchtower/channels';
import { plainTextToHtml, type Reply } from '@watchtower/shared';

export { plainTextToHtml };

/** Text as a comparison key: whitespace runs collapsed, so layout alone is not a difference. */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * A reply from the email composer: the HTML is rebuilt through the same allow-list the inbound mail
 * goes through (no script, style, event handler or remote resource; images only as `cid:`), so what
 * is stored and sent is safe whatever the browser posted. The plain-text alternative is the
 * person's own text; when they sent none the text is derived from the sanitised HTML.
 */
export function prepareEmailReply(reply: Reply): Reply {
  const email = reply.email;
  if (email === undefined) return reply;
  // Approving an AI draft checks the text against the draft; the HTML the customer reads must be that
  // same text, so whatever HTML the browser posted is replaced by the draft's text (N3, audit).
  if (reply.aiDraftId !== undefined) {
    return { ...reply, email: { ...email, bodyHtml: plainTextToHtml(reply.body) } };
  }
  if (email.bodyHtml === undefined || email.bodyHtml.trim() === '') {
    const rest = { ...email };
    delete rest.bodyHtml;
    return { ...reply, email: rest };
  }
  const clean = gmail.sanitizeHtml(email.bodyHtml);
  // An edit of an AI draft is measured on the text the customer reads. When the text field and the HTML
  // disagree (beyond layout) the HTML wins, so the draft's words cannot be counted as "unchanged" while
  // different words go out (T-171a C-2).
  const derived =
    reply.editedFromDraftId !== undefined && squash(clean.text) !== squash(reply.body)
      ? clean.text
      : null;
  return {
    ...reply,
    body: derived ?? (reply.body.trim() === '' ? clean.text : reply.body),
    email: { ...email, bodyHtml: clean.html },
  };
}

/**
 * The stored attachment records of a reply, with the uploads the HTML shows inline marked as such
 * (`disposition: inline` + `contentId`), so the dispatcher sends them as `multipart/related` parts.
 * `records` are in the order of `ids`.
 */
export function markInlineImages(
  records: readonly Record<string, unknown>[],
  ids: readonly string[],
  inline: readonly { attachmentId: string; contentId: string }[],
): Record<string, unknown>[] {
  return records.map((record, index) => {
    const mark = inline.find((entry) => entry.attachmentId === ids[index]);
    return mark === undefined
      ? record
      : { ...record, disposition: 'inline', contentId: mark.contentId, referencedByHtml: true };
  });
}
