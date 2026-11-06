import * as ToggleGroup from '@radix-ui/react-toggle-group';

import { cn } from '../lib/cn.js';
import { FlagIcon, type FlagCode } from './flag-icon.js';
import { Tooltip } from './tooltip.js';

export interface LanguageFlagOption<T extends string> {
  value: T;
  flag: FlagCode;
  /** The language's own name in that language ("ภาษาไทย", "English"). */
  label: string;
}

export interface LanguageFlagsProps<T extends string> {
  options: readonly LanguageFlagOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  /** Names the group ("Language"). */
  'aria-label': string;
  className?: string;
}

/**
 * Two flag buttons side by side, one per language (docs/design/less-text-ai-assistant.md 1.3). A
 * single flag would be ambiguous (the language now, or the one it switches to), so both show and
 * the chosen one has a 2 px ring and `aria-checked`. A flag is not a language: the picture is
 * decoration and each button is named by the language's own name, with `lang` set so a screen
 * reader says it right. Arrow keys move between them.
 */
export function LanguageFlags<T extends string>({
  options,
  value,
  onValueChange,
  className,
  ...props
}: LanguageFlagsProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        const match = options.find((option) => option.value === next);
        if (match) onValueChange(match.value);
      }}
      aria-label={props['aria-label']}
      className={cn('inline-flex items-center gap-1.5', className)}
    >
      {options.map((option) => (
        <Tooltip key={option.value} content={<span lang={option.value}>{option.label}</span>}>
          <ToggleGroup.Item
            value={option.value}
            lang={option.value}
            aria-label={option.label}
            className={cn(
              'inline-flex h-7 w-8 cursor-pointer items-center justify-center rounded-full outline-hidden hover:bg-surface-muted focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:h-9 max-md:w-11',
              'data-[state=on]:bg-surface-muted data-[state=on]:ring-2 data-[state=on]:ring-primary',
            )}
          >
            <FlagIcon code={option.flag} />
          </ToggleGroup.Item>
        </Tooltip>
      ))}
    </ToggleGroup.Root>
  );
}
