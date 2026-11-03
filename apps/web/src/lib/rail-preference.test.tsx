import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getRailExpanded,
  RAIL_STORAGE_KEY,
  resetRailPreference,
  setRailExpanded,
  useRailExpanded,
} from './rail-preference';

function Probe() {
  return <p data-testid="rail">{useRailExpanded() ? 'expanded' : 'collapsed'}</p>;
}

beforeEach(() => {
  localStorage.clear();
  resetRailPreference();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('rail preference', () => {
  it('is expanded by default', () => {
    render(<Probe />);
    expect(screen.getByTestId('rail')).toHaveTextContent('expanded');
  });

  it('reads a saved collapse on the first render', () => {
    localStorage.setItem(RAIL_STORAGE_KEY, '0');
    render(<Probe />);
    expect(screen.getByTestId('rail')).toHaveTextContent('collapsed');
  });

  it('falls back to expanded for a corrupt value', () => {
    localStorage.setItem(RAIL_STORAGE_KEY, 'maybe');
    expect(getRailExpanded()).toBe(true);
  });

  it('saves the choice and updates readers', () => {
    render(<Probe />);
    act(() => {
      setRailExpanded(false);
    });
    expect(localStorage.getItem(RAIL_STORAGE_KEY)).toBe('0');
    expect(screen.getByTestId('rail')).toHaveTextContent('collapsed');
    act(() => {
      setRailExpanded(true);
    });
    expect(localStorage.getItem(RAIL_STORAGE_KEY)).toBe('1');
    expect(screen.getByTestId('rail')).toHaveTextContent('expanded');
  });

  it('follows a change made in another tab', () => {
    render(<Probe />);
    act(() => {
      localStorage.setItem(RAIL_STORAGE_KEY, '0');
      window.dispatchEvent(new StorageEvent('storage', { key: RAIL_STORAGE_KEY }));
    });
    expect(screen.getByTestId('rail')).toHaveTextContent('collapsed');
  });

  it('still works for the page when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<Probe />);
    expect(screen.getByTestId('rail')).toHaveTextContent('expanded');
    act(() => {
      setRailExpanded(false);
    });
    expect(screen.getByTestId('rail')).toHaveTextContent('collapsed');
  });
});
