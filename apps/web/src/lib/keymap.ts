import type { MessageKey } from '@/i18n';

export type KeymapGroup = 'navigation' | 'ticket' | 'general' | 'ai';

export interface KeymapEntry {
  id: string;
  /** Key caps as shown, one string per key to press in sequence or together (`Ctrl`, `K`). */
  keys: readonly string[];
  labelKey: MessageKey;
  group: KeymapGroup;
  /** False for a shortcut that is listed but not wired yet (the AI draft actions, Phase 1). */
  available: boolean;
}

/**
 * Every keyboard shortcut of the workspace. The `?` dialog renders this list, so the map and the
 * behaviour are described in one place. The handlers live next to the thing they act on.
 */
export const KEYMAP: readonly KeymapEntry[] = [
  { id: 'next', keys: ['J'], labelKey: 'keymap.next', group: 'navigation', available: true },
  { id: 'prev', keys: ['K'], labelKey: 'keymap.prev', group: 'navigation', available: true },
  { id: 'search', keys: ['/'], labelKey: 'keymap.search', group: 'navigation', available: true },
  { id: 'loadNew', keys: ['.'], labelKey: 'keymap.loadNew', group: 'navigation', available: true },
  { id: 'reply', keys: ['C'], labelKey: 'keymap.reply', group: 'ticket', available: true },
  { id: 'note', keys: ['N'], labelKey: 'keymap.note', group: 'ticket', available: true },
  { id: 'details', keys: ['S'], labelKey: 'keymap.details', group: 'ticket', available: true },
  {
    id: 'send',
    keys: ['Ctrl', 'Enter'],
    labelKey: 'keymap.send',
    group: 'ticket',
    available: true,
  },
  { id: 'leave', keys: ['Esc'], labelKey: 'keymap.leave', group: 'general', available: true },
  {
    id: 'palette',
    keys: ['Ctrl', 'K'],
    labelKey: 'keymap.palette',
    group: 'general',
    available: true,
  },
  { id: 'help', keys: ['?'], labelKey: 'keymap.help', group: 'general', available: true },
  { id: 'approve', keys: ['A'], labelKey: 'keymap.approve', group: 'ai', available: false },
  { id: 'edit', keys: ['E'], labelKey: 'keymap.edit', group: 'ai', available: false },
  { id: 'reject', keys: ['R'], labelKey: 'keymap.reject', group: 'ai', available: false },
];
