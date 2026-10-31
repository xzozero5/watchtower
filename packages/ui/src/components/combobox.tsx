import { Command } from 'cmdk';
import { Check, Plus } from 'lucide-react';
import { type ReactNode, type Ref, useState } from 'react';

import { cn } from '../lib/cn.js';
import { Popover, PopoverContent, PopoverTrigger } from './popover.js';

export interface ComboboxOption {
  value: string;
  label: string;
  icon?: ReactNode;
  /** Extra words the search also matches. */
  keywords?: readonly string[];
  disabled?: boolean;
}

interface BaseProps {
  options: readonly ComboboxOption[];
  /**
   * Name of the field, read before its value ("Status" then "Open"). It is hidden text inside the
   * trigger, so the accessible name is built from what is visible (WCAG 2.5.3 Label in Name).
   * Leave it out when the trigger's own text says it all, such as "Insert template".
   */
  fieldLabel?: string;
  /** What the trigger shows. It looks like plain text until hovered. */
  children: ReactNode;
  searchPlaceholder: string;
  emptyText: string;
  /** Name of the list for assistive technology. */
  listLabel: string;
  /** Read after the chosen option(s), for example "Selected". The check mark itself is decorative. */
  selectedText: string;
  disabled?: boolean;
  /** Controlled open state, for shortcuts that open the field. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  id?: string;
  triggerRef?: Ref<HTMLButtonElement>;
  className?: string;
  contentClassName?: string;
}

export interface SingleComboboxProps extends BaseProps {
  multiple?: false;
  value: string;
  onValueChange: (value: string) => void;
}

export interface MultiComboboxProps extends BaseProps {
  multiple: true;
  values: readonly string[];
  onToggle: (value: string) => void;
  /** Offers "create" for text that matches no option. */
  onCreate?: (text: string) => void;
  createLabel?: (text: string) => string;
}

export type ComboboxProps = SingleComboboxProps | MultiComboboxProps;

/**
 * A value that reads like text until hovered, and opens a searchable list (Popover + cmdk): type to
 * filter, arrows to move, Enter to choose, Escape to close. A single field closes after a choice;
 * a multiple field stays open so several can be toggled.
 */
export function Combobox(props: ComboboxProps) {
  const [innerOpen, setInnerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const open = props.open ?? innerOpen;
  const setOpen = (next: boolean) => {
    if (props.open === undefined) setInnerOpen(next);
    props.onOpenChange?.(next);
    if (!next) setSearch('');
  };

  const isSelected = (value: string) =>
    props.multiple ? props.values.includes(value) : props.value === value;

  const choose = (value: string) => {
    if (props.multiple) {
      props.onToggle(value);
      return;
    }
    props.onValueChange(value);
    setOpen(false);
  };

  const trimmed = search.trim();
  const canCreate =
    props.multiple === true &&
    props.onCreate !== undefined &&
    trimmed !== '' &&
    !props.options.some((option) => option.label.toLowerCase() === trimmed.toLowerCase());

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={props.id}
          ref={props.triggerRef}
          type="button"
          disabled={props.disabled}
          className={cn(
            '-mx-2 flex min-h-control w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors duration-(--wt-motion-duration-fast) ease-out hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring disabled:pointer-events-none data-[state=open]:bg-surface-muted',
            props.className,
          )}
        >
          {props.fieldLabel ? <span className="sr-only">{props.fieldLabel}: </span> : null}
          {props.children}
        </button>
      </PopoverTrigger>
      <PopoverContent className={cn('w-64 p-0', props.contentClassName)}>
        <Command
          label={props.searchPlaceholder}
          // cmdk matches `value` plus `keywords`; labels travel as keywords so Thai text matches too.
          filter={(value, query, keywords) => {
            const haystack = `${value} ${(keywords ?? []).join(' ')}`.toLowerCase();
            return haystack.includes(query.trim().toLowerCase()) ? 1 : 0;
          }}
        >
          <div className="border-b border-border px-2">
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder={props.searchPlaceholder}
              aria-label={props.searchPlaceholder}
              className="h-control w-full bg-transparent text-sm text-foreground outline-hidden placeholder:text-muted-foreground"
            />
          </div>
          <Command.List label={props.listLabel} className="max-h-64 overflow-y-auto p-1">
            <Command.Empty className="px-2 py-3 text-center text-sm text-muted-foreground">
              {props.emptyText}
            </Command.Empty>
            {props.options.map((option) => (
              <Command.Item
                key={option.value}
                value={option.value}
                keywords={[option.label, ...(option.keywords ?? [])]}
                disabled={option.disabled}
                onSelect={() => {
                  choose(option.value);
                }}
                className="flex min-h-row cursor-default items-center gap-2 rounded-md px-2 text-sm data-[disabled=true]:opacity-50 data-[selected=true]:bg-surface-muted"
              >
                {option.icon}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {isSelected(option.value) ? (
                  <>
                    <Check aria-hidden className="size-4 shrink-0" />
                    <span className="sr-only">{props.selectedText}</span>
                  </>
                ) : null}
              </Command.Item>
            ))}
            {canCreate ? (
              <Command.Item
                value="__create__"
                forceMount
                onSelect={() => {
                  props.onCreate?.(trimmed);
                  setSearch('');
                }}
                className="flex min-h-row cursor-default items-center gap-2 rounded-md px-2 text-sm data-[selected=true]:bg-surface-muted"
              >
                <Plus aria-hidden className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {props.createLabel ? props.createLabel(trimmed) : trimmed}
                </span>
              </Command.Item>
            ) : null}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
