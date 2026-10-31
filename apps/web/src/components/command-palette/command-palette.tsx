'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '@watchtower/ui';
import { Search } from 'lucide-react';
import { type KeyboardEvent, useId, useMemo, useState } from 'react';

import { useT } from '@/i18n/provider';

import { type Command, type CommandGroup, filterCommands, moveIndex } from './commands';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: readonly Command[];
}

/** Opens with Ctrl+K or Cmd+K (see use-palette-shortcut). Closing it clears the query. */
export function CommandPalette({ open, onOpenChange, commands }: CommandPaletteProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        {/* The body remounts on every open, so the query and highlight reset without an effect. */}
        <PaletteBody
          commands={commands}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PaletteBody({ commands, onClose }: { commands: readonly Command[]; onClose: () => void }) {
  const t = useT();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const activeIndex = results.length === 0 ? -1 : Math.min(active, results.length - 1);
  const optionId = (id: string) => `${listId}-${id}`;
  const activeCommand = activeIndex >= 0 ? results[activeIndex] : undefined;

  const run = (command: Command) => {
    command.run();
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(moveIndex(activeIndex, event.key === 'ArrowDown' ? 1 : -1, results.length));
    } else if (event.key === 'Enter' && activeCommand) {
      event.preventDefault();
      run(activeCommand);
    }
  };

  const groupLabel = (group: CommandGroup) =>
    group === 'display' ? t('palette.groups.display') : t('palette.groups.language');

  return (
    <Dialog.Content className="fixed top-[12vh] left-1/2 z-50 w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-lg border border-border-strong bg-surface text-foreground shadow-lg">
      <Dialog.Title className="sr-only">{t('palette.title')}</Dialog.Title>
      <Dialog.Description className="sr-only">{t('palette.description')}</Dialog.Description>

      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <input
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={results.length > 0 ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={activeCommand ? optionId(activeCommand.id) : undefined}
          aria-label={t('palette.title')}
          placeholder={t('palette.placeholder')}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-control w-full bg-transparent text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      </div>

      {results.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('palette.listLabel')}
          className="max-h-[50vh] overflow-y-auto p-1"
        >
          {results.map((command, index) => (
            <li
              key={command.id}
              id={optionId(command.id)}
              role="option"
              aria-selected={index === activeIndex}
              onPointerMove={() => {
                setActive(index);
              }}
              onClick={() => {
                run(command);
              }}
              className={cn(
                'flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm',
                index === activeIndex && 'bg-primary text-primary-foreground',
              )}
            >
              <span>{command.label}</span>
              <span
                className={cn(
                  'text-xs',
                  index === activeIndex ? 'text-primary-foreground' : 'text-muted-foreground',
                )}
              >
                {groupLabel(command.group)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div role="status" className="px-4 py-8 text-center">
          <p className="text-sm font-semibold">{t('palette.empty')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('palette.emptyHint')}</p>
        </div>
      )}
    </Dialog.Content>
  );
}
