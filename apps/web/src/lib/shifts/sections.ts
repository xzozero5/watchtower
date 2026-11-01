import type { Permission } from '@watchtower/shared';

import type { MessageKey } from '@/i18n';

export const SHIFT_SECTION_IDS = ['shift', 'brief', 'handoff', 'notes', 'overview'] as const;
export type ShiftSectionId = (typeof SHIFT_SECTION_IDS)[number];

export interface ShiftSection {
  id: ShiftSectionId;
  href: string;
  labelKey: MessageKey;
  /** Shown to a person who holds at least one of these. The api checks the same on every call. */
  anyOf: readonly Permission[];
}

/** docs/06-UI-SPEC.md section 9: the shift screens and which permission opens each. */
export const SHIFT_SECTIONS: readonly ShiftSection[] = [
  { id: 'shift', href: '/shift', labelKey: 'shift.nav.shift', anyOf: ['shift.clock'] },
  { id: 'brief', href: '/shift/brief', labelKey: 'shift.nav.brief', anyOf: ['shift.clock'] },
  {
    id: 'handoff',
    href: '/shift/handoff',
    labelKey: 'shift.nav.handoff',
    anyOf: ['handoff.write'],
  },
  { id: 'notes', href: '/shift/notes', labelKey: 'shift.nav.notes', anyOf: ['shift.note.write'] },
  {
    id: 'overview',
    href: '/shift/overview',
    labelKey: 'shift.nav.overview',
    anyOf: ['roster.manage', 'performance.read.all'],
  },
];

export function shiftSectionsFor(can: (permission: Permission) => boolean): ShiftSection[] {
  return SHIFT_SECTIONS.filter((section) => section.anyOf.some((permission) => can(permission)));
}

/** The person has any shift screen at all (the rail shows the item). */
export function canSeeShift(can: (permission: Permission) => boolean): boolean {
  return shiftSectionsFor(can).length > 0;
}
