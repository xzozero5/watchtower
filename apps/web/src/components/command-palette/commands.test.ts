import { describe, expect, it, vi } from 'vitest';

import { getMessages, type Translate, translate } from '@/i18n';

import { buildCommands, type CommandActions, filterCommands, moveIndex } from './commands';

const actions = (): CommandActions => ({
  setTheme: vi.fn(),
  setDensity: vi.fn(),
  setLocale: vi.fn(),
  showShortcuts: vi.fn(),
  focusSearch: vi.fn(),
  signOut: vi.fn(),
});

const tEn: Translate = (key, values) => translate(getMessages('en'), key, values);
const tTh: Translate = (key, values) => translate(getMessages('th'), key, values);

describe('buildCommands', () => {
  it('translates labels into the current language', () => {
    expect(buildCommands(tEn, actions()).map((c) => c.label)).toContain('Theme: dark');
    expect(buildCommands(tTh, actions()).map((c) => c.label)).toContain('ธีม: มืด');
  });

  it('runs the matching action', () => {
    const a = actions();
    const byId = new Map(buildCommands(tEn, a).map((c) => [c.id, c]));
    byId.get('theme.dark')?.run();
    byId.get('density.compact')?.run();
    byId.get('language.th')?.run();
    expect(a.setTheme).toHaveBeenCalledWith('dark');
    expect(a.setDensity).toHaveBeenCalledWith('compact');
    expect(a.setLocale).toHaveBeenCalledWith('th');
  });

  it('has unique ids', () => {
    const ids = buildCommands(tEn, actions()).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('filterCommands', () => {
  const commands = buildCommands(tEn, actions());

  it('returns everything for an empty query', () => {
    expect(filterCommands(commands, '')).toHaveLength(commands.length);
    expect(filterCommands(commands, '   ')).toHaveLength(commands.length);
  });

  it('matches the label without regard to case', () => {
    expect(filterCommands(commands, 'DARK').map((c) => c.id)).toEqual(['theme.dark']);
  });

  it('requires every word to match', () => {
    expect(filterCommands(commands, 'theme dark').map((c) => c.id)).toEqual(['theme.dark']);
    expect(filterCommands(commands, 'theme compact')).toEqual([]);
  });

  it('matches Thai keywords on English labels and the reverse', () => {
    expect(filterCommands(commands, 'ธีม')).toHaveLength(3);
    expect(filterCommands(buildCommands(tTh, actions()), 'theme')).toHaveLength(3);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterCommands(commands, 'zzz')).toEqual([]);
  });
});

describe('moveIndex', () => {
  it('moves and wraps in both directions', () => {
    expect(moveIndex(0, 1, 3)).toBe(1);
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(moveIndex(0, -1, 3)).toBe(2);
  });

  it('returns -1 for an empty list', () => {
    expect(moveIndex(0, 1, 0)).toBe(-1);
  });
});
