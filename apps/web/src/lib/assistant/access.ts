import { WORKSPACE_ROLES, type SessionInfo } from '@watchtower/shared';

/** The client session has orgId, not the server principal's orgScope; the API checks orgScope again. */
export function isAssistantWorkspace(session: SessionInfo | null): boolean {
  return (
    session !== null &&
    (WORKSPACE_ROLES as readonly string[]).includes(session.user.role) &&
    session.user.orgId === null
  );
}
