import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight, Circle } from 'lucide-react';
import type { ComponentProps, HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

/**
 * Menus are not modal: the rest of the page is not hidden from assistive technology while one is
 * open (a modal menu hides it with `aria-hidden` yet leaves it focusable, which axe rightly flags).
 * Focus still moves into the menu, Escape closes it and returns focus, and a click outside closes it.
 */
export function DropdownMenu(props: ComponentProps<typeof Menu.Root>) {
  return <Menu.Root modal={false} {...props} />;
}
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuGroup = Menu.Group;
export const DropdownMenuSub = Menu.Sub;
export const DropdownMenuRadioGroup = Menu.RadioGroup;

const PANEL =
  'z-50 min-w-48 animate-pop-in rounded-lg border border-border bg-surface p-1 text-foreground shadow-overlay outline-hidden';
const ITEM =
  'relative flex min-h-row cursor-default items-center gap-2 rounded-md px-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-muted data-[state=open]:bg-surface-muted';

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(PANEL, className)}
        {...props}
      />
    </Menu.Portal>
  );
}

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Menu.Item>) {
  return <Menu.Item className={cn(ITEM, className)} {...props} />;
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem className={cn(ITEM, 'pr-8', className)} {...props}>
      {children}
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <Menu.ItemIndicator>
          <Check aria-hidden className="size-4" />
        </Menu.ItemIndicator>
      </span>
    </Menu.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  hideIndicator = false,
  ...props
}: ComponentProps<typeof Menu.RadioItem> & {
  /** For a compact icon-only choice that shows the chosen one another way (a ring). */
  hideIndicator?: boolean;
}) {
  return (
    <Menu.RadioItem className={cn(ITEM, hideIndicator ? 'pr-2' : 'pr-8', className)} {...props}>
      {children}
      {hideIndicator ? null : (
        <span className="absolute right-2 flex size-4 items-center justify-center">
          <Menu.ItemIndicator>
            <Circle aria-hidden className="size-2 fill-current" />
          </Menu.ItemIndicator>
        </span>
      )}
    </Menu.RadioItem>
  );
}

export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof Menu.SubTrigger>) {
  return (
    <Menu.SubTrigger className={cn(ITEM, 'pr-2', className)} {...props}>
      {children}
      <ChevronRight aria-hidden className="ml-auto size-4 text-muted-foreground" />
    </Menu.SubTrigger>
  );
}

export function DropdownMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof Menu.SubContent>) {
  return (
    <Menu.Portal>
      <Menu.SubContent
        sideOffset={4}
        collisionPadding={8}
        className={cn(PANEL, className)}
        {...props}
      />
    </Menu.Portal>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Menu.Label>) {
  return (
    <Menu.Label className={cn('px-2 py-1.5 text-xs text-muted-foreground', className)} {...props} />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}

/** Right-aligned hint inside a menu item, such as a shortcut. */
export function DropdownMenuHint({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('ml-auto text-xs text-muted-foreground', className)} {...props} />;
}
