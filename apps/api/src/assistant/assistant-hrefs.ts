/**
 * The pages a claim may link to (T-135, ADR-023 section 9). Only pages that exist in `apps/web` are
 * listed, because a chip must open something real. A ticket opens in the queue with the ticket in
 * the side pane (`/?ticket=OPS-1`, the way the web itself links). There is no knowledge base, incident
 * or alert page in the web yet, so evidence of those kinds carries no `href` and the chip says there
 * is no link; add the page here when it exists.
 */
export const ticketHref = (key: string): string => `/?ticket=${encodeURIComponent(key)}`;

/** The queue narrowed to one person, the way a link from Home names one. */
export const assigneeHref = (userId: string): string => `/?assignee=${encodeURIComponent(userId)}`;

export const BRIEF_HREF = '/shift/brief';
export const HANDOFF_HREF = '/shift/handoff';
export const NOTES_HREF = '/shift/notes';
