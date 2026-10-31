import type { Density, ThemePreference } from '@watchtower/ui';

import type { Locale, MessageKey, Translate } from '@/i18n';

export type CommandGroup = 'general' | 'display' | 'language';

export interface Command {
  id: string;
  /** Already translated. */
  label: string;
  group: CommandGroup;
  /** Extra words that should find this command, in both languages. */
  keywords: readonly string[];
  run: () => void;
}

export interface CommandActions {
  setTheme: (theme: ThemePreference) => void;
  setDensity: (density: Density) => void;
  setLocale: (locale: Locale) => void;
  setSingleKeyShortcuts: (enabled: boolean) => void;
  showShortcuts: () => void;
  focusSearch: () => void;
  signOut: () => void;
}

interface Definition {
  id: string;
  labelKey: MessageKey;
  group: CommandGroup;
  keywords: readonly string[];
  run: (actions: CommandActions) => void;
}

// Keywords are searchable aliases in both languages, so "ธีม" and "theme" find the same command.
const DEFINITIONS: readonly Definition[] = [
  {
    id: 'go.search',
    labelKey: 'commands.focusSearch',
    group: 'general',
    keywords: ['search', 'find', 'queue', 'filter', 'ค้นหา', 'คิว'],
    run: (a) => {
      a.focusSearch();
    },
  },
  {
    id: 'help.shortcuts',
    labelKey: 'commands.showShortcuts',
    group: 'general',
    keywords: ['keyboard', 'shortcuts', 'keys', 'help', 'คีย์ลัด', 'แป้นพิมพ์', 'ช่วยเหลือ'],
    run: (a) => {
      a.showShortcuts();
    },
  },
  {
    id: 'shortcuts.singleKeyOff',
    labelKey: 'commands.singleKeyOff',
    group: 'general',
    keywords: ['single key', 'shortcuts', 'keyboard', 'disable', 'off', 'คีย์ลัด', 'ปิด'],
    run: (a) => {
      a.setSingleKeyShortcuts(false);
    },
  },
  {
    id: 'shortcuts.singleKeyOn',
    labelKey: 'commands.singleKeyOn',
    group: 'general',
    keywords: ['single key', 'shortcuts', 'keyboard', 'enable', 'on', 'คีย์ลัด', 'เปิด'],
    run: (a) => {
      a.setSingleKeyShortcuts(true);
    },
  },
  {
    id: 'session.signOut',
    labelKey: 'commands.signOut',
    group: 'general',
    keywords: ['sign out', 'log out', 'logout', 'ออกจากระบบ'],
    run: (a) => {
      a.signOut();
    },
  },
  {
    id: 'theme.system',
    labelKey: 'commands.themeSystem',
    group: 'display',
    keywords: ['theme', 'system', 'os', 'auto', 'ธีม', 'ตามระบบ'],
    run: (a) => {
      a.setTheme('system');
    },
  },
  {
    id: 'theme.light',
    labelKey: 'commands.themeLight',
    group: 'display',
    keywords: ['theme', 'light', 'ธีม', 'สว่าง'],
    run: (a) => {
      a.setTheme('light');
    },
  },
  {
    id: 'theme.dark',
    labelKey: 'commands.themeDark',
    group: 'display',
    keywords: ['theme', 'dark', 'night', 'ธีม', 'มืด'],
    run: (a) => {
      a.setTheme('dark');
    },
  },
  {
    id: 'density.comfortable',
    labelKey: 'commands.densityComfortable',
    group: 'display',
    keywords: ['density', 'spacing', 'comfortable', 'ความหนาแน่น', 'สบายตา'],
    run: (a) => {
      a.setDensity('comfortable');
    },
  },
  {
    id: 'density.compact',
    labelKey: 'commands.densityCompact',
    group: 'display',
    keywords: ['density', 'spacing', 'compact', 'ความหนาแน่น', 'กะทัดรัด'],
    run: (a) => {
      a.setDensity('compact');
    },
  },
  {
    id: 'language.en',
    labelKey: 'commands.languageEnglish',
    group: 'language',
    keywords: ['language', 'english', 'en', 'ภาษา', 'อังกฤษ'],
    run: (a) => {
      a.setLocale('en');
    },
  },
  {
    id: 'language.th',
    labelKey: 'commands.languageThai',
    group: 'language',
    keywords: ['language', 'thai', 'th', 'ภาษา', 'ไทย'],
    run: (a) => {
      a.setLocale('th');
    },
  },
];

/** The commands available now. Ticket-level commands (assign, set status, ...) come with the AI sidebar. */
export function buildCommands(t: Translate, actions: CommandActions): Command[] {
  return DEFINITIONS.map(({ id, labelKey, group, keywords, run }) => ({
    id,
    label: t(labelKey),
    group,
    keywords,
    run: () => {
      run(actions);
    },
  }));
}

/** Case-insensitive match on the label and the keywords. Every word of the query must match. */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...commands];
  return commands.filter((command) => {
    const haystack = [command.label, ...command.keywords].join(' ').toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** Moves the highlighted index by `delta` and wraps around. Returns -1 for an empty list. */
export function moveIndex(current: number, delta: number, length: number): number {
  if (length === 0) return -1;
  return (((current + delta) % length) + length) % length;
}
