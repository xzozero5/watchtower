import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { formatMessageTime } from './format';
import { useModifierShortcut } from './use-modifier-shortcut';

function Probe({ onKey }: { onKey: () => void }) {
  useModifierShortcut('b', onKey);
  return null;
}

describe('useModifierShortcut', () => {
  it('fires for Ctrl+B and Cmd+B, by typed letter or by physical key (Thai layout)', () => {
    const onKey = vi.fn();
    render(<Probe onKey={onKey} />);
    fireEvent.keyDown(document.body, { key: 'b', code: 'KeyB', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'B', code: 'KeyB', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'ิ', code: 'KeyB', ctrlKey: true });
    expect(onKey).toHaveBeenCalledTimes(3);
  });

  it('ignores a bare letter, other modifiers and other letters', () => {
    const onKey = vi.fn();
    render(<Probe onKey={onKey} />);
    fireEvent.keyDown(document.body, { key: 'b', code: 'KeyB' });
    fireEvent.keyDown(document.body, { key: 'b', code: 'KeyB', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(document.body, { key: 'b', code: 'KeyB', ctrlKey: true, altKey: true });
    fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', ctrlKey: true });
    expect(onKey).not.toHaveBeenCalled();
  });

  it('does not act while a dialog is open, and prevents the browser default when it does', () => {
    const onKey = vi.fn();
    render(<Probe onKey={onKey} />);
    const press = () => {
      const event = new KeyboardEvent('keydown', {
        key: 'b',
        code: 'KeyB',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(event);
      return event;
    };
    expect(press().defaultPrevented).toBe(true);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-state', 'open');
    document.body.append(dialog);
    expect(press().defaultPrevented).toBe(false);
    expect(onKey).toHaveBeenCalledTimes(1);
    dialog.remove();
  });
});

describe('formatMessageTime', () => {
  const NOW = Date.parse('2026-11-02T08:00:00.000Z'); // 15:00 in Asia/Bangkok

  it('is the time of day for a message sent today, in Bangkok time', () => {
    expect(formatMessageTime('2026-11-02T03:42:00.000Z', 'en', NOW)).toMatch(/10:42\s?AM/);
  });

  it('adds the date for another day', () => {
    expect(formatMessageTime('2026-11-01T03:42:00.000Z', 'en', NOW)).toMatch(/Nov 1.*10:42\s?AM/);
  });

  it('uses the Bangkok day, not the UTC day, to decide what is today', () => {
    // 18:30 UTC on Nov 1 is 01:30 on Nov 2 in Bangkok: still "today" for 15:00 on Nov 2.
    expect(formatMessageTime('2026-11-01T18:30:00.000Z', 'en', NOW)).toMatch(/^1:30\s?AM$/);
  });

  it('follows the UI language', () => {
    expect(formatMessageTime('2026-11-01T03:42:00.000Z', 'th', NOW)).toMatch(/พ\.ย\./);
  });
});
