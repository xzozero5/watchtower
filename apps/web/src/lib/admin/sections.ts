import type { Permission } from '@watchtower/shared';

import type { MessageKey } from '@/i18n';

export const ADMIN_SECTION_IDS = [
  'users',
  'orgs',
  'sla',
  'intents',
  'queues',
  'shifts',
  'ai',
  'audit',
  'integrations',
] as const;
export type AdminSectionId = (typeof ADMIN_SECTION_IDS)[number];

export interface AdminSection {
  id: AdminSectionId;
  href: string;
  labelKey: MessageKey;
  /** The permission that shows the section. The api checks the same permission on every call. */
  permission: Permission;
}

/** docs/06-UI-SPEC.md section 18.1: which permission opens which admin section. */
export const ADMIN_SECTIONS: readonly AdminSection[] = [
  { id: 'users', href: '/admin/users', labelKey: 'admin.sections.users', permission: 'user.read' },
  { id: 'orgs', href: '/admin/orgs', labelKey: 'admin.sections.orgs', permission: 'org.manage' },
  { id: 'sla', href: '/admin/sla', labelKey: 'admin.sections.sla', permission: 'sla.manage' },
  {
    id: 'intents',
    href: '/admin/intents',
    labelKey: 'admin.sections.intents',
    permission: 'intent.manage',
  },
  {
    id: 'queues',
    href: '/admin/queues',
    labelKey: 'admin.sections.queues',
    permission: 'queue.manage',
  },
  {
    id: 'shifts',
    href: '/admin/shifts',
    labelKey: 'admin.sections.shifts',
    permission: 'roster.manage',
  },
  { id: 'ai', href: '/admin/ai', labelKey: 'admin.sections.ai', permission: 'ai.autonomy.set' },
  { id: 'audit', href: '/admin/audit', labelKey: 'admin.sections.audit', permission: 'audit.read' },
  {
    id: 'integrations',
    href: '/admin/integrations',
    labelKey: 'admin.sections.integrations',
    permission: 'integration.manage',
  },
];

/** The sections this person may open, in menu order. Others are hidden, not disabled. */
export function adminSectionsFor(can: (permission: Permission) => boolean): AdminSection[] {
  return ADMIN_SECTIONS.filter((section) => can(section.permission));
}

export function adminSection(id: AdminSectionId): AdminSection {
  const found = ADMIN_SECTIONS.find((section) => section.id === id);
  if (!found) throw new Error(`unknown admin section ${id}`);
  return found;
}

/** Home is for head and lead: both hold `user.read` (docs/06-UI-SPEC.md section 18.9 H1). */
export const HOME_PERMISSION: Permission = 'user.read';

/** The person may flip the two AI switches: head only (`ai.emergency_switch` and `ai.autonomy.set.any`). */
export function canFlipSwitches(can: (permission: Permission) => boolean): boolean {
  return can('ai.emergency_switch') && can('ai.autonomy.set.any');
}
