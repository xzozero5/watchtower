import type { AiSwitchKey, Permission } from '@watchtower/shared';
import type { Density, ThemePreference } from '@watchtower/ui';

import type { Locale, MessageKey, Translate } from '@/i18n';
import { adminSectionsFor, canFlipSwitches, HOME_PERMISSION } from '@/lib/admin/sections';
import type { TicketField } from '@/lib/tickets/field-focus';
import { shiftSectionsFor } from '@/lib/shifts/sections';

export type CommandGroup = 'ticket' | 'general' | 'display' | 'language' | 'admin';

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
  /** Head console (T-127). Only used when `buildCommands` is given the person's permissions. */
  goHome?: () => void;
  goAdmin?: (href: string) => void;
  /** Shift screens (T-111f): My shift, Daily brief, Handoff, Notes, Lead view. */
  goTo?: (href: string) => void;
  /** Opens the AI assistant panel for a workspace session with assistant.use. */
  askAssistant?: () => void;
  /** Jumps to a field of the open ticket (UI-SPEC section 14: S / P / I). Only for people who can handle tickets. */
  focusTicketField?: (field: TicketField) => void;
  /** Opens the confirm dialog for a switch; it never flips the switch itself. */
  openSwitchDialog?: (switchKey: AiSwitchKey, on: boolean) => void;
}

/** What decides which admin commands exist: the person's permissions and the current switch state. */
export interface CommandAccess {
  can: (permission: Permission) => boolean;
  assistantWorkspace?: boolean;
  /** The current state of the two AI switches, once known: the label says "Stop" or "Resume". */
  ai?: { killOn: boolean; capOn: boolean };
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

const ADMIN_KEYWORDS = ['admin', 'settings', 'manage', 'ผู้ดูแล', 'ตั้งค่า', 'จัดการ'] as const;

/** Navigation and AI-switch commands for a head or lead (docs/06-UI-SPEC.md section 18.1). */
function adminCommands(t: Translate, actions: CommandActions, access: CommandAccess): Command[] {
  const commands: Command[] = [];
  if (access.can(HOME_PERMISSION) && actions.goHome) {
    const goHome = actions.goHome;
    commands.push({
      id: 'go.home',
      label: t('commands.goHome'),
      group: 'admin',
      keywords: ['home', 'dashboard', 'overview', 'หน้าหลัก', 'ภาพรวม'],
      run: goHome,
    });
  }
  const goTo = actions.goTo;
  if (goTo) {
    for (const section of shiftSectionsFor(access.can)) {
      commands.push({
        id: `go.shift.${section.id}`,
        label: t('commands.goShift', { section: t(section.labelKey) }),
        group: 'admin',
        keywords: ['shift', 'clock', 'handoff', 'brief', 'roster', 'กะ', 'เวร', 'ส่งมอบ'],
        run: () => {
          goTo(section.href);
        },
      });
    }
  }
  const goAdmin = actions.goAdmin;
  if (goAdmin) {
    for (const section of adminSectionsFor(access.can)) {
      commands.push({
        id: `go.admin.${section.id}`,
        label: t('commands.goAdmin', { section: t(section.labelKey) }),
        group: 'admin',
        keywords: [...ADMIN_KEYWORDS, section.id],
        run: () => {
          goAdmin(section.href);
        },
      });
    }
  }
  const openSwitchDialog = actions.openSwitchDialog;
  if (openSwitchDialog && canFlipSwitches(access.can)) {
    const killOn = access.ai?.killOn ?? false;
    const capOn = access.ai?.capOn ?? false;
    commands.push(
      {
        id: killOn ? 'ai.resume' : 'ai.stop',
        label: t(killOn ? 'commands.aiResume' : 'commands.aiStop'),
        group: 'admin',
        keywords: ['ai', 'kill', 'stop', 'pause', 'resume', 'emergency', 'หยุด', 'ฉุกเฉิน'],
        run: () => {
          openSwitchDialog('ai_kill_switch', !killOn);
        },
      },
      {
        id: capOn ? 'ai.unlimit' : 'ai.limit',
        label: t(capOn ? 'commands.aiUnlimit' : 'commands.aiLimit'),
        group: 'admin',
        keywords: ['ai', 'stage', 'limit', 'cap', 'emergency', 'ขั้น', 'จำกัด', 'ฉุกเฉิน'],
        run: () => {
          openSwitchDialog('ai_stage_cap_pinned', !capOn);
        },
      },
    );
  }
  return commands;
}

const TICKET_COMMANDS: readonly {
  field: TicketField;
  labelKey: MessageKey;
  keywords: readonly string[];
}[] = [
  {
    field: 'status',
    labelKey: 'commands.ticketStatus',
    keywords: ['ticket', 'status', 'resolve', 'close', 'สถานะ', 'ปิดงาน'],
  },
  {
    field: 'priority',
    labelKey: 'commands.ticketPriority',
    keywords: ['ticket', 'priority', 'severity', 'p1', 'ความสำคัญ', 'ด่วน'],
  },
  {
    field: 'assignee',
    labelKey: 'commands.ticketAssign',
    keywords: ['ticket', 'assign', 'assignee', 'owner', 'me', 'มอบหมาย', 'ผู้รับผิดชอบ'],
  },
];

/** Status, priority and assignee of the open ticket (UI-SPEC section 14). Needs `ticket.handle`. */
function ticketCommands(t: Translate, actions: CommandActions, access: CommandAccess): Command[] {
  const focus = actions.focusTicketField;
  if (!focus || !access.can('ticket.handle')) return [];
  return TICKET_COMMANDS.map(({ field, labelKey, keywords }) => ({
    id: `ticket.${field}`,
    label: t(labelKey),
    group: 'ticket' as const,
    keywords,
    run: () => {
      focus(field);
    },
  }));
}

/**
 * The commands available now. Ticket-level commands (assign, set status, ...) come with the AI
 * sidebar. With `access`, the admin group is added for a head or lead.
 */
export function buildCommands(
  t: Translate,
  actions: CommandActions,
  access?: CommandAccess,
): Command[] {
  const base = DEFINITIONS.map(({ id, labelKey, group, keywords, run }) => ({
    id,
    label: t(labelKey),
    group,
    keywords,
    run: () => {
      run(actions);
    },
  }));
  if (!access) return base;
  const ask = actions.askAssistant;
  const assistant: Command[] =
    ask && access.assistantWorkspace === true && access.can('assistant.use')
      ? [
          {
            id: 'ai.ask',
            label: t('commands.askAssistant'),
            group: 'general',
            keywords: [
              'ai',
              'assistant',
              'ask',
              'chat',
              'help',
              'birdday',
              'cockatiel',
              'bird',
              'ผู้ช่วย',
              'ถาม',
              'แชท',
              'นก',
              'ค็อกคาเทล',
            ],
            run: ask,
          },
        ]
      : [];
  return [
    ...ticketCommands(t, actions, access),
    ...adminCommands(t, actions, access),
    ...assistant,
    ...base,
  ];
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
