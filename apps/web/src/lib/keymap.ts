import type { Permission } from '@watchtower/shared';

import type { MessageKey } from '@/i18n';

export type KeymapGroup = 'navigation' | 'panes' | 'ticket' | 'general' | 'ai';

export interface KeymapEntry {
  id: string;
  /** Key caps as shown, one string per key to press in sequence or together (`Ctrl`, `K`). */
  keys: readonly string[];
  /** Other ways to do the same thing. They are always single characters (preference-controlled). */
  alternatives?: readonly (readonly string[])[];
  /** True when `keys` are pressed one after the other (`g` then `q`) instead of together. */
  sequence?: boolean;
  labelKey: MessageKey;
  group: KeymapGroup;
  /** False for a shortcut that is listed but not wired yet. */
  available: boolean;
  /**
   * True when `keys` is a single printable character, so the "single-key shortcuts" preference
   * (WCAG 2.1.4) turns it off. Ctrl/Alt combinations, F6 and keys that only act while a control
   * has focus (Enter in the queue, Esc) are not affected.
   */
  singleKey: boolean;
  /**
   * The shortcut is listed only for a user who holds at least one of these permissions: a customer
   * is not shown the keys for notes, status changes or AI drafts (the api enforces the same).
   */
  requires?: readonly Permission[];
}

const CAN_REPLY: readonly Permission[] = ['ticket.reply', 'ticket.reply.own'];
const CAN_HANDLE: readonly Permission[] = ['ticket.handle'];
const CAN_REVIEW_AI: readonly Permission[] = ['ai.draft.review'];

/**
 * Every keyboard shortcut of the workspace. The `?` dialog renders this list, so the map and the
 * behaviour are described in one place. The handlers live next to the thing they act on.
 * The keys follow docs/06-UI-SPEC.md section 14.
 */
export const KEYMAP: readonly KeymapEntry[] = [
  {
    id: 'next',
    keys: ['J'],
    labelKey: 'keymap.next',
    group: 'navigation',
    available: true,
    singleKey: true,
  },
  {
    id: 'prev',
    keys: ['K'],
    labelKey: 'keymap.prev',
    group: 'navigation',
    available: true,
    singleKey: true,
  },
  {
    id: 'open',
    keys: ['Enter'],
    alternatives: [['O']],
    labelKey: 'keymap.open',
    group: 'navigation',
    available: true,
    singleKey: false,
  },
  {
    id: 'search',
    keys: ['/'],
    labelKey: 'keymap.search',
    group: 'navigation',
    available: true,
    singleKey: true,
  },
  {
    id: 'loadNew',
    keys: ['.'],
    labelKey: 'keymap.loadNew',
    group: 'navigation',
    available: true,
    singleKey: true,
  },
  {
    id: 'panesCycle',
    keys: ['F6'],
    alternatives: [['Shift', 'F6']],
    labelKey: 'keymap.panesCycle',
    group: 'panes',
    available: true,
    singleKey: false,
  },
  {
    id: 'panesJump',
    keys: ['Alt', '1–3'],
    labelKey: 'keymap.panesJump',
    group: 'panes',
    available: true,
    singleKey: false,
  },
  {
    id: 'collapseQueue',
    keys: ['['],
    labelKey: 'keymap.collapseQueue',
    group: 'panes',
    available: true,
    singleKey: true,
  },
  {
    id: 'collapseAssistant',
    keys: [']'],
    labelKey: 'keymap.collapseAssistant',
    group: 'panes',
    available: true,
    singleKey: true,
    requires: CAN_REVIEW_AI,
  },
  {
    id: 'goQueue',
    keys: ['G', 'Q'],
    sequence: true,
    labelKey: 'keymap.goQueue',
    group: 'panes',
    available: true,
    singleKey: true,
  },
  {
    id: 'goHome',
    keys: ['G', 'D'],
    sequence: true,
    labelKey: 'keymap.goHome',
    group: 'panes',
    available: true,
    singleKey: true,
    requires: ['user.read'],
  },
  {
    id: 'goAdmin',
    keys: ['G', 'A'],
    sequence: true,
    labelKey: 'keymap.goAdmin',
    group: 'panes',
    available: true,
    singleKey: true,
    requires: [
      'user.read',
      'org.manage',
      'sla.manage',
      'intent.manage',
      'queue.manage',
      'ai.autonomy.set',
      'audit.read',
      'integration.manage',
    ],
  },
  {
    id: 'goOtherMail',
    keys: ['G', 'O'],
    sequence: true,
    labelKey: 'keymap.goOtherMail',
    group: 'panes',
    available: false,
    singleKey: true,
    requires: CAN_HANDLE,
  },
  {
    id: 'goBrief',
    keys: ['G', 'B'],
    sequence: true,
    labelKey: 'keymap.goBrief',
    group: 'panes',
    available: false,
    singleKey: true,
    requires: CAN_HANDLE,
  },
  {
    id: 'goHandoff',
    keys: ['G', 'H'],
    sequence: true,
    labelKey: 'keymap.goHandoff',
    group: 'panes',
    available: false,
    singleKey: true,
    requires: CAN_HANDLE,
  },
  {
    id: 'goNotifications',
    keys: ['G', 'N'],
    sequence: true,
    labelKey: 'keymap.goNotifications',
    group: 'panes',
    available: false,
    singleKey: true,
    requires: CAN_HANDLE,
  },
  {
    id: 'reply',
    keys: ['C'],
    labelKey: 'keymap.reply',
    group: 'ticket',
    available: true,
    singleKey: true,
    requires: CAN_REPLY,
  },
  {
    id: 'note',
    keys: ['N'],
    labelKey: 'keymap.note',
    group: 'ticket',
    available: true,
    singleKey: true,
    requires: CAN_HANDLE,
  },
  {
    id: 'details',
    keys: ['S'],
    labelKey: 'keymap.details',
    group: 'ticket',
    available: true,
    singleKey: true,
    requires: CAN_HANDLE,
  },
  {
    id: 'send',
    keys: ['Ctrl', 'Enter'],
    labelKey: 'keymap.send',
    group: 'ticket',
    available: true,
    singleKey: false,
    requires: [...CAN_REPLY, ...CAN_HANDLE],
  },
  {
    id: 'leave',
    keys: ['Esc'],
    labelKey: 'keymap.leave',
    group: 'general',
    available: true,
    singleKey: false,
  },
  {
    id: 'palette',
    keys: ['Ctrl', 'K'],
    labelKey: 'keymap.palette',
    group: 'general',
    available: true,
    singleKey: false,
  },
  {
    id: 'rail',
    keys: ['Ctrl', 'B'],
    labelKey: 'keymap.rail',
    group: 'general',
    available: true,
    singleKey: false,
  },
  {
    id: 'help',
    keys: ['?'],
    labelKey: 'keymap.help',
    group: 'general',
    available: true,
    singleKey: true,
  },
  {
    id: 'approve',
    keys: ['A'],
    labelKey: 'keymap.approve',
    group: 'ai',
    available: true,
    singleKey: true,
    requires: CAN_REVIEW_AI,
  },
  {
    id: 'edit',
    keys: ['E'],
    labelKey: 'keymap.edit',
    group: 'ai',
    available: true,
    singleKey: true,
    requires: CAN_REVIEW_AI,
  },
  {
    id: 'reject',
    keys: ['R'],
    labelKey: 'keymap.reject',
    group: 'ai',
    available: true,
    singleKey: true,
    requires: CAN_REVIEW_AI,
  },
];

/** The shortcuts a user with these permissions may use, in map order. */
export function keymapFor(can: (permission: Permission) => boolean): KeymapEntry[] {
  return KEYMAP.filter((entry) => !entry.requires || entry.requires.some((p) => can(p)));
}
