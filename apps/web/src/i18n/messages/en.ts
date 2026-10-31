/**
 * English UI copy. This file is the source of truth for the message shape: th.ts must provide the
 * same keys (the compiler checks it), and every `{placeholder}` must appear in both languages
 * (messages.test.ts checks it). Never put UI text in a component: add a key here and in th.ts.
 */
export const en = {
  app: {
    name: 'Watchtower',
    description: 'Tech operations command center',
    skipToContent: 'Skip to the conversation',
  },
  topbar: {
    openPalette: 'Open command palette',
    preferences: 'Display and language',
  },
  panes: {
    queue: {
      title: 'Queue',
      emptyTitle: 'No tickets yet',
      emptyBody: 'New tickets from every channel will appear here, most urgent first.',
    },
    conversation: {
      title: 'Conversation',
      emptyTitle: 'Select a ticket',
      emptyBody: 'Pick a ticket from the queue to read the thread and reply.',
    },
    assistant: {
      title: 'AI assistant',
      emptyTitle: 'Nothing to investigate',
      emptyBody:
        'Open a ticket and the report, evidence and a draft reply will show up here for you to review.',
    },
  },
  severity: {
    p1: 'Critical',
    p2: 'High',
    p3: 'Medium',
    p4: 'Low',
    keyTitle: 'Severity key',
    keyHint: 'Every level has its own icon and label, not only a colour.',
  },
  palette: {
    title: 'Command palette',
    description: 'Type to filter commands, use the arrow keys to move and Enter to run.',
    placeholder: 'Type a command',
    listLabel: 'Commands',
    empty: 'No matching commands',
    emptyHint: 'Try a different word, such as "theme" or "language".',
    groups: {
      display: 'Display',
      language: 'Language',
    },
  },
  commands: {
    themeSystem: 'Theme: follow system',
    themeLight: 'Theme: light',
    themeDark: 'Theme: dark',
    densityComfortable: 'Density: comfortable',
    densityCompact: 'Density: compact',
    languageEnglish: 'Language: English',
    languageThai: 'Language: Thai',
  },
  prefs: {
    theme: { label: 'Theme', system: 'System', light: 'Light', dark: 'Dark' },
    density: { label: 'Density', comfortable: 'Comfortable', compact: 'Compact' },
    language: { label: 'Language' },
  },
  apiStatus: {
    label: 'API status',
    checking: 'Checking API',
    online: 'API online',
    offline: 'API unreachable',
  },
  loading: {
    label: 'Loading',
  },
  errors: {
    title: 'Something went wrong',
    body: 'The page could not be shown. Your work was not changed. Try again.',
    retry: 'Try again',
    notFoundTitle: 'Page not found',
    notFoundBody: 'This page does not exist or has moved.',
    backHome: 'Back to the queue',
  },
} as const;

type Widen<T> = T extends string ? string : { readonly [K in keyof T]: Widen<T[K]> };

/** The shape every language must fill in, with plain `string` leaves. */
export type Messages = Widen<typeof en>;
