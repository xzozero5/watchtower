import type { Permission } from '@watchtower/shared';

import type { MessageKey } from '@/i18n';

export const OPS_SECTION_IDS = ['alerts', 'services', 'incidents', 'status-page'] as const;
export type OpsSectionId = (typeof OPS_SECTION_IDS)[number];

export interface OpsSection {
  id: OpsSectionId;
  href: string;
  labelKey: MessageKey;
  /** Shown to a person who holds at least one of these. The api checks the same on every call. */
  anyOf: readonly Permission[];
}

/** The operations screens (alerts, services, incidents, status page) and which permission opens each. */
export const OPS_SECTIONS: readonly OpsSection[] = [
  { id: 'alerts', href: '/alerts', labelKey: 'ops.nav.alerts', anyOf: ['alert.read'] },
  {
    id: 'services',
    href: '/alerts/services',
    labelKey: 'ops.nav.services',
    anyOf: ['alert.read'],
  },
  { id: 'incidents', href: '/incidents', labelKey: 'ops.nav.incidents', anyOf: ['ticket.read'] },
  {
    id: 'status-page',
    href: '/status-page',
    labelKey: 'ops.nav.statusPage',
    anyOf: ['incident.create', 'incident.manage', 'service.manage'],
  },
];

export function opsSectionsFor(can: (permission: Permission) => boolean): OpsSection[] {
  return OPS_SECTIONS.filter((section) => section.anyOf.some((permission) => can(permission)));
}
