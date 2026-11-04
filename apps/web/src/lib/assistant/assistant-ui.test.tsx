import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useModifierShortcut } from '@/lib/use-modifier-shortcut';

import {
  ASSISTANT_HIDDEN_STORAGE_KEY,
  requestAssistantOpen,
  resetAssistantHiddenCache,
  setAssistantHidden,
  useAssistantHidden,
  useAssistantOpenRequests,
} from './assistant-ui';
import { liftFor } from './use-bubble-room';

beforeEach(() => {
  localStorage.clear();
  resetAssistantHiddenCache();
  vi.restoreAllMocks();
});

describe('the hidden choice', () => {
  it('starts shown, is remembered in this browser, and can be undone', () => {
    const { result } = renderHook(() => useAssistantHidden());
    expect(result.current).toBe(false);
    act(() => {
      setAssistantHidden(true);
    });
    expect(result.current).toBe(true);
    expect(localStorage.getItem(ASSISTANT_HIDDEN_STORAGE_KEY)).toBe('hidden');
    act(() => {
      setAssistantHidden(false);
    });
    expect(result.current).toBe(false);
    expect(localStorage.getItem(ASSISTANT_HIDDEN_STORAGE_KEY)).toBeNull();
  });

  it('reads a saved choice on load, and treats any other value as shown', () => {
    localStorage.setItem(ASSISTANT_HIDDEN_STORAGE_KEY, 'hidden');
    expect(renderHook(() => useAssistantHidden()).result.current).toBe(true);
    resetAssistantHiddenCache();
    localStorage.setItem(ASSISTANT_HIDDEN_STORAGE_KEY, 'garbage');
    expect(renderHook(() => useAssistantHidden()).result.current).toBe(false);
  });

  it('still works for the page when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const { result } = renderHook(() => useAssistantHidden());
    expect(result.current).toBe(false);
    act(() => {
      setAssistantHidden(true);
    });
    expect(result.current).toBe(true);
  });

  it('follows a change made in another tab', () => {
    const { result } = renderHook(() => useAssistantHidden());
    localStorage.setItem(ASSISTANT_HIDDEN_STORAGE_KEY, 'hidden');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: ASSISTANT_HIDDEN_STORAGE_KEY }));
    });
    expect(result.current).toBe(true);
  });
});

describe('the open request', () => {
  it('reaches every listener, and stops after unmount', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => {
      useAssistantOpenRequests(handler);
    });
    requestAssistantOpen();
    expect(handler).toHaveBeenCalledTimes(1);
    unmount();
    requestAssistantOpen();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('liftFor', () => {
  const viewport = { width: 1000, height: 800 };
  const bar = (over: Partial<{ top: number; right: number; bottom: number; height: number }>) => ({
    top: 740,
    right: 1000,
    bottom: 800,
    height: 60,
    ...over,
  });

  it('lifts the button above a bar that reaches its corner', () => {
    expect(liftFor([bar({})], viewport)).toBe(68);
  });

  it('ignores a bar that does not reach the right edge or the bottom, or has no size', () => {
    expect(liftFor([bar({ right: 600 })], viewport)).toBe(0);
    expect(liftFor([bar({ top: 100, bottom: 160 })], viewport)).toBe(0);
    expect(liftFor([bar({ height: 0 })], viewport)).toBe(0);
    expect(liftFor([], viewport)).toBe(0);
  });

  it('takes the tallest bar, and never lifts past 40% of the window', () => {
    expect(liftFor([bar({}), bar({ top: 700, height: 100 })], viewport)).toBe(108);
    expect(liftFor([bar({ top: 100, height: 700 })], viewport)).toBe(320);
  });
});

describe('Ctrl or Cmd + /', () => {
  function Probe({ onKey }: { onKey: () => void }) {
    useModifierShortcut('/', onKey);
    return null;
  }

  it('fires by typed slash or by the physical key (Thai layout), not bare or with Shift', () => {
    const onKey = vi.fn();
    render(<Probe onKey={onKey} />);
    fireEvent.keyDown(document.body, { key: '/', code: 'Slash', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'ฝ', code: 'Slash', metaKey: true });
    expect(onKey).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document.body, { key: '/', code: 'Slash' });
    fireEvent.keyDown(document.body, { key: '?', code: 'Slash', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(document.body, { key: 'j', code: 'KeyJ', ctrlKey: true });
    expect(onKey).toHaveBeenCalledTimes(2);
  });
});
