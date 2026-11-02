import { Moon, Sun } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';
import { Tooltip } from './tooltip.js';

export interface ThemeSwitchProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'role' | 'aria-checked' | 'aria-label' | 'onChange' | 'children'
> {
  /** True while the dark theme is the one in effect (the saved choice, or the system's). */
  dark: boolean;
  onDarkChange: (dark: boolean) => void;
  /** The name: "Dark theme". The switch is on when dark is in effect. */
  label: string;
}

/**
 * The moon / sun switch (docs/design/less-text-ai-assistant.md 1.2). Two states: it shows the theme
 * that is in effect, and a press saves the other one. The track holds both icons and a knob that
 * covers one of them, so the state reads without colour. The knob does not slide for people who
 * prefer reduced motion.
 */
export function ThemeSwitch({ dark, onDarkChange, label, className, ...props }: ThemeSwitchProps) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        role="switch"
        aria-checked={dark}
        aria-label={label}
        onClick={() => {
          onDarkChange(!dark);
        }}
        className={cn(
          'relative inline-flex h-7 w-14 shrink-0 cursor-pointer items-center justify-between rounded-full bg-surface-muted px-2 text-muted-foreground shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_70%,transparent)] outline-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:h-9 max-md:w-16',
          className,
        )}
        {...props}
      >
        <Sun aria-hidden className="size-4" />
        <Moon aria-hidden className="size-4" />
        <span
          aria-hidden
          data-knob
          className={cn(
            'absolute top-0.5 left-0.5 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-soft transition-transform duration-(--wt-motion-duration-fast) ease-out motion-reduce:transition-none max-md:size-8',
            dark ? 'translate-x-7 max-md:translate-x-7' : 'translate-x-0',
          )}
        >
          {dark ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
        </span>
      </button>
    </Tooltip>
  );
}
