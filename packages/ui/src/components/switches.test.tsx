import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FlagIcon } from './flag-icon.js';
import { LanguageFlags } from './language-flags.js';
import { ThemeSwitch } from './theme-switch.js';
import { TooltipProvider } from './tooltip.js';

describe('ThemeSwitch', () => {
  it('is a switch named by its label, on while dark is in effect', () => {
    const onDarkChange = vi.fn();
    const { rerender } = render(
      <TooltipProvider>
        <ThemeSwitch dark={false} onDarkChange={onDarkChange} label="Dark theme" />
      </TooltipProvider>,
    );
    const toggle = screen.getByRole('switch', { name: 'Dark theme' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(onDarkChange).toHaveBeenLastCalledWith(true);

    rerender(
      <TooltipProvider>
        <ThemeSwitch dark onDarkChange={onDarkChange} label="Dark theme" />
      </TooltipProvider>,
    );
    expect(screen.getByRole('switch', { name: 'Dark theme' })).toBeChecked();
    fireEvent.click(screen.getByRole('switch', { name: 'Dark theme' }));
    expect(onDarkChange).toHaveBeenLastCalledWith(false);
  });

  it('draws both icons so the state is not carried by colour alone', () => {
    const { container } = render(
      <TooltipProvider>
        <ThemeSwitch dark={false} onDarkChange={() => undefined} label="Dark theme" />
      </TooltipProvider>,
    );
    // Sun and Moon in the track, and the same icon again in the knob.
    expect(container.querySelectorAll('svg')).toHaveLength(3);
    for (const icon of container.querySelectorAll('svg')) {
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    }
  });
});

describe('LanguageFlags', () => {
  const options = [
    { value: 'th', flag: 'th', label: 'ภาษาไทย' },
    { value: 'en', flag: 'gb', label: 'English' },
  ] as const;

  it('shows both languages as radios named in their own language, the chosen one checked', () => {
    const onValueChange = vi.fn();
    render(
      <TooltipProvider>
        <LanguageFlags
          options={options}
          value="en"
          onValueChange={onValueChange}
          aria-label="Language"
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole('radiogroup', { name: 'Language' })).toBeInTheDocument();
    const thai = screen.getByRole('radio', { name: 'ภาษาไทย' });
    const english = screen.getByRole('radio', { name: 'English' });
    expect(english).toBeChecked();
    expect(thai).not.toBeChecked();
    expect(thai).toHaveAttribute('lang', 'th');
    expect(english).toHaveAttribute('lang', 'en');
    fireEvent.click(thai);
    expect(onValueChange).toHaveBeenCalledWith('th');
    // Pressing the chosen one does not leave the group empty.
    fireEvent.click(english);
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });
});

describe('FlagIcon', () => {
  it('is decoration: an inline svg hidden from assistive technology, 20 by 14', () => {
    const { container } = render(<FlagIcon code="th" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('viewBox', '0 0 20 14');
    expect(svg?.querySelectorAll('rect')).toHaveLength(3);
    const gb = render(<FlagIcon code="gb" />).container.querySelector('svg');
    expect(gb?.querySelectorAll('path')).toHaveLength(4);
  });
});
