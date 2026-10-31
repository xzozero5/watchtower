import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isShortcut,
  paneCommand,
  SEQUENCE_TIMEOUT_MS,
  type ShortcutEvent,
  useShortcut,
  useShortcutSequence,
} from './keyboard';
import { resetPreferencesCache, setSingleKeyShortcuts } from './preferences';

const press = (overrides: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
  key: 'j',
  code: 'KeyJ',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  target: document.body,
  defaultPrevented: false,
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  resetPreferencesCache();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('isShortcut', () => {
  it('matches the typed character and the physical key (Thai layout)', () => {
    expect(isShortcut(press(), 'j')).toBe(true);
    expect(isShortcut(press({ key: '่', code: 'KeyJ' }), 'j')).toBe(true);
    expect(isShortcut(press({ key: '[', code: 'BracketLeft' }), '[')).toBe(true);
    expect(isShortcut(press({ key: 'ฟ', code: 'BracketRight' }), ']')).toBe(true);
    expect(isShortcut(press({ key: 'ย', code: 'Slash', shiftKey: true }), '?')).toBe(true);
  });

  it('ignores modifiers and text fields', () => {
    expect(isShortcut(press({ ctrlKey: true }), 'j')).toBe(false);
    expect(isShortcut(press({ altKey: true }), 'j')).toBe(false);
    const input = document.createElement('input');
    expect(isShortcut(press({ target: input }), 'j')).toBe(false);
  });

  it('does nothing at all once single-key shortcuts are turned off, and works again when on', () => {
    setSingleKeyShortcuts(false);
    expect(isShortcut(press(), 'j')).toBe(false);
    expect(isShortcut(press({ key: '่', code: 'KeyJ' }), 'j')).toBe(false);
    expect(isShortcut(press({ key: '?', code: 'Slash', shiftKey: true }), '?')).toBe(false);
    setSingleKeyShortcuts(true);
    expect(isShortcut(press(), 'j')).toBe(true);
  });
});

describe('paneCommand', () => {
  const base = (o: Partial<ShortcutEvent>) => press({ key: '', code: '', ...o });

  it('maps F6, Shift+F6 and Alt+1..3', () => {
    expect(paneCommand(base({ key: 'F6', code: 'F6' }))).toEqual({ type: 'cycle', delta: 1 });
    expect(paneCommand(base({ key: 'F6', code: 'F6', shiftKey: true }))).toEqual({
      type: 'cycle',
      delta: -1,
    });
    expect(paneCommand(base({ key: '1', code: 'Digit1', altKey: true }))).toEqual({
      type: 'jump',
      index: 0,
    });
    // On a Mac Alt+3 types a different character: the physical key still counts.
    expect(paneCommand(base({ key: '£', code: 'Digit3', altKey: true }))).toEqual({
      type: 'jump',
      index: 2,
    });
  });

  it('ignores other keys, a bare digit and Alt+4', () => {
    expect(paneCommand(base({ key: '1', code: 'Digit1' }))).toBeNull();
    expect(paneCommand(base({ key: '4', code: 'Digit4', altKey: true }))).toBeNull();
    expect(paneCommand(base({ key: 'F6', code: 'F6', ctrlKey: true }))).toBeNull();
  });

  it('is not a single-character shortcut: it still works with those off, and from a field', () => {
    setSingleKeyShortcuts(false);
    const input = document.createElement('input');
    expect(paneCommand(base({ key: 'F6', code: 'F6', target: input }))).toEqual({
      type: 'cycle',
      delta: 1,
    });
  });
});

describe('useShortcut', () => {
  it('stops firing when single-key shortcuts are turned off', () => {
    const handler = vi.fn();
    function Probe() {
      useShortcut('j', handler);
      return null;
    }
    render(<Probe />);
    fireEvent.keyDown(document.body, { key: 'j', code: 'KeyJ' });
    expect(handler).toHaveBeenCalledTimes(1);
    setSingleKeyShortcuts(false);
    fireEvent.keyDown(document.body, { key: 'j', code: 'KeyJ' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('useShortcutSequence', () => {
  const setup = () => {
    const goQueue = vi.fn();
    const other = vi.fn();
    function Probe() {
      useShortcutSequence('g', { q: goQueue });
      useShortcut('j', other);
      return null;
    }
    render(<Probe />);
    return { goQueue, other };
  };
  const key = (k: string, code: string, extra: KeyboardEventInit = {}) =>
    fireEvent.keyDown(document.body, { key: k, code, ...extra });

  it('runs the action on g then q, also by physical key', () => {
    const { goQueue } = setup();
    key('g', 'KeyG');
    key('q', 'KeyQ');
    expect(goQueue).toHaveBeenCalledTimes(1);
    key('g', 'KeyG');
    key('ๆ', 'KeyQ');
    expect(goQueue).toHaveBeenCalledTimes(2);
  });

  it('needs g first, and a Shift press in between does not break it', () => {
    const { goQueue } = setup();
    key('q', 'KeyQ');
    expect(goQueue).not.toHaveBeenCalled();
    key('g', 'KeyG');
    key('Shift', 'ShiftLeft');
    key('q', 'KeyQ');
    expect(goQueue).toHaveBeenCalledTimes(1);
  });

  it('is cancelled by another key, which still does its own job', () => {
    const { goQueue, other } = setup();
    key('g', 'KeyG');
    key('j', 'KeyJ');
    expect(other).toHaveBeenCalledTimes(1);
    key('q', 'KeyQ');
    expect(goQueue).not.toHaveBeenCalled();
  });

  it('times out', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { goQueue } = setup();
    key('g', 'KeyG');
    vi.setSystemTime(Date.now() + SEQUENCE_TIMEOUT_MS + 1);
    key('q', 'KeyQ');
    expect(goQueue).not.toHaveBeenCalled();
  });

  it('does nothing in a text field, with a modifier, or with single-key shortcuts off', () => {
    const { goQueue } = setup();
    const input = document.createElement('input');
    document.body.append(input);
    fireEvent.keyDown(input, { key: 'g', code: 'KeyG' });
    fireEvent.keyDown(input, { key: 'q', code: 'KeyQ' });
    input.remove();
    key('g', 'KeyG');
    key('q', 'KeyQ', { ctrlKey: true });
    setSingleKeyShortcuts(false);
    key('g', 'KeyG');
    key('q', 'KeyQ');
    expect(goQueue).not.toHaveBeenCalled();
  });
});
