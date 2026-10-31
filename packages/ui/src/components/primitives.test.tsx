import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AVATAR_HUE_COUNT } from '../tokens/colors.js';
import { Avatar, avatarHue, initialsOf } from './avatar.js';
import { Button } from './button.js';
import { Combobox } from './combobox.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './dropdown-menu.js';
import { EmptyState } from './empty-state.js';
import { Pill, StatusDot, StatusPill } from './pill.js';
import { SegmentedControl } from './segmented-control.js';
import { SeverityBadge } from './severity-badge.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs.js';
import { Toaster, toast } from './toaster.js';
import { Tooltip, TooltipProvider } from './tooltip.js';

describe('Avatar', () => {
  it('takes initials from the first and last word, in Latin and in Thai', () => {
    expect(initialsOf('Alex Agent')).toBe('AA');
    expect(initialsOf('mali wong')).toBe('MW');
    expect(initialsOf('Cher')).toBe('C');
    expect(initialsOf('Ana Maria Souza')).toBe('AS');
    expect(initialsOf('  ')).toBe('');
    // A Thai leading vowel is written before its consonant: the initial is the consonant.
    expect(initialsOf('สมชาย ใจดี')).toBe('สจ');
    expect(initialsOf('เกษม')).toBe('ก');
  });

  it('gives the same id the same hue, and every hue is one of the tokens', () => {
    expect(avatarHue('a0000000-0000-4000-8000-000000000601')).toBe(
      avatarHue('a0000000-0000-4000-8000-000000000601'),
    );
    const seen = new Set<number>();
    for (let index = 0; index < 200; index += 1) {
      const hue = avatarHue(`person-${String(index)}`);
      expect(hue).toBeGreaterThanOrEqual(1);
      expect(hue).toBeLessThanOrEqual(AVATAR_HUE_COUNT);
      seen.add(hue);
    }
    // 200 ids spread over all eight hues.
    expect(seen.size).toBe(AVATAR_HUE_COUNT);
  });

  it('is decorative next to a name, named when alone, and never an image', () => {
    const { container, rerender } = render(<Avatar name="Alex Agent" id="u1" size={24} />);
    const avatar = container.firstElementChild;
    expect(avatar).toHaveAttribute('aria-hidden', 'true');
    expect(avatar).toHaveTextContent('AA');
    expect(container.querySelector('img')).toBeNull();
    rerender(<Avatar name="Alex Agent" aria-label="Assigned to Alex Agent" />);
    expect(screen.getByRole('img', { name: 'Assigned to Alex Agent' })).toBeInTheDocument();
  });
});

describe('pills', () => {
  it('shows a status as a dot plus words, with the dot hidden from screen readers', () => {
    const { container } = render(<StatusPill tone="success" label="Resolved" />);
    expect(screen.getByText('Resolved')).toBeVisible();
    expect(container.querySelector('[data-tone="success"]')).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws the hollow dot with a border so the shape differs from the filled one', () => {
    const { container } = render(
      <>
        <StatusDot tone="info" />
        <StatusDot tone="outline" />
      </>,
    );
    const [filled, hollow] = Array.from(container.querySelectorAll('span'));
    expect(filled?.className).toContain('bg-link');
    expect(hollow?.className).toContain('border');
  });

  it('is a 20px rounded-full outline by default', () => {
    render(<Pill>vip</Pill>);
    expect(screen.getByText('vip')).toHaveClass('h-5', 'rounded-full', 'border');
  });
});

describe('SeverityBadge as a pill', () => {
  it('fills only P1; the other levels are outlined', () => {
    const { container, rerender } = render(<SeverityBadge severity="p1" label="Critical" />);
    expect(container.firstElementChild).toHaveClass('bg-sev-p1-bg', 'rounded-full', 'h-5');
    for (const id of ['p2', 'p3', 'p4'] as const) {
      rerender(<SeverityBadge severity={id} label="x" />);
      expect(container.firstElementChild).toHaveClass('bg-transparent');
    }
  });

  it('reads "P1 Critical" with a space, so the text matches an accessible name', () => {
    const { container } = render(<SeverityBadge severity="p1" label="Critical" />);
    expect(container).toHaveTextContent('P1 Critical');
  });
});

describe('Button', () => {
  it('renders its child instead of a button with asChild, keeping the look', () => {
    render(
      <Button asChild variant="primary">
        <a href="/x">Go</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Go' });
    expect(link).toHaveClass('bg-primary', 'h-control');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('has one sentence, an optional action and a keyboard hint, and a decorative icon', () => {
    const { container } = render(
      <EmptyState
        icon={<svg />}
        title="All caught up"
        description="Nothing waiting."
        action={<button type="button">Clear</button>}
        hint="Press / to search"
      />,
    );
    expect(screen.getByText('All caught up')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeVisible();
    expect(screen.getByText('Press / to search')).toBeVisible();
    expect(container.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
  });
});

describe('SegmentedControl', () => {
  function Harness({ onChange }: { onChange?: (value: string) => void }) {
    const [value, setValue] = useState<'reply' | 'note'>('reply');
    return (
      <SegmentedControl
        aria-label="Kind"
        value={value}
        onValueChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
        options={[
          { value: 'reply', label: 'Reply' },
          { value: 'note', label: 'Internal note' },
        ]}
      />
    );
  }

  it('selects one option at a time and never ends up with none', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    expect(screen.getByRole('radio', { name: 'Reply' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Internal note' }));
    expect(screen.getByRole('radio', { name: 'Internal note' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Reply' })).not.toBeChecked();
    // Pressing the selected one again does not clear it.
    fireEvent.click(screen.getByRole('radio', { name: 'Internal note' }));
    expect(screen.getByRole('radio', { name: 'Internal note' })).toBeChecked();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('radiogroup', { name: 'Kind' })).toBeInTheDocument();
  });
});

describe('Tabs', () => {
  it('shows one panel at a time and marks the selected tab', () => {
    render(
      <Tabs defaultValue="a">
        <TabsList aria-label="Panel">
          <TabsTrigger value="a">Details</TabsTrigger>
          <TabsTrigger value="b">Customer</TabsTrigger>
        </TabsList>
        <TabsContent value="a">First</TabsContent>
        <TabsContent value="b">Second</TabsContent>
      </Tabs>,
    );
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('First')).toBeVisible();
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
    // Radix tabs select on a mouse press or on focus; focus is what an arrow key does.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Customer' }), { button: 0 });
    expect(screen.getByText('Second')).toBeVisible();
  });
});

describe('Tooltip', () => {
  it('opens on keyboard focus with the words and the shortcut, as a tooltip', async () => {
    render(
      <TooltipProvider>
        <Tooltip content="Command palette" shortcut={['Ctrl', 'K']}>
          <button type="button" aria-label="Open command palette">
            x
          </button>
        </Tooltip>
      </TooltipProvider>,
    );
    act(() => {
      screen.getByRole('button', { name: 'Open command palette' }).focus();
    });
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Command palette');
    expect(tip).toHaveTextContent('Ctrl');
    expect(tip).toHaveTextContent('K');
  });

  it('can be switched off without wrapping the child', () => {
    render(
      <TooltipProvider>
        <Tooltip content="Nope" disabled>
          <button type="button">y</button>
        </Tooltip>
      </TooltipProvider>,
    );
    act(() => {
      screen.getByRole('button', { name: 'y' }).focus();
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});

describe('DropdownMenu', () => {
  it('opens from the keyboard and picks a radio item, then closes', async () => {
    const onValue = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Theme</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="light" onValueChange={onValue}>
            <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'Theme' }), { key: 'Enter' });
    expect(await screen.findByRole('menuitemradio', { name: 'Light' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Dark' }), { key: 'Enter' });
    expect(onValue).toHaveBeenCalledWith('dark');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  it('does not hide the rest of the page from assistive technology while open', async () => {
    render(
      <>
        <p>Page content</p>
        <DropdownMenu>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value="a">
              <DropdownMenuRadioItem value="a">A</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </>,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'Open' }), { key: 'Enter' });
    await screen.findByRole('menu');
    expect(screen.getByText('Page content').closest('[aria-hidden="true"]')).toBeNull();
  });
});

const OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed', keywords: ['done'] },
];

describe('Combobox', () => {
  function Single({ onChange }: { onChange: (value: string) => void }) {
    const [value, setValue] = useState('open');
    return (
      <Combobox
        fieldLabel="Status"
        listLabel="Status"
        searchPlaceholder="Search"
        emptyText="No matches"
        selectedText="Selected"
        options={OPTIONS}
        value={value}
        onValueChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      >
        {OPTIONS.find((option) => option.value === value)?.label}
      </Combobox>
    );
  }

  it('looks like text, is named "field: value", opens a searchable list and closes after a choice', async () => {
    const onChange = vi.fn();
    render(<Single onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: /^Status:\s*Open/ });
    fireEvent.click(trigger);

    const list = await screen.findByRole('listbox', { name: 'Status' });
    expect(within(list).getAllByRole('option')).toHaveLength(3);
    // The chosen option says so in words as well as with a check mark.
    expect(within(list).getByRole('option', { name: /^Open\s*Selected/ })).toBeInTheDocument();

    // Search by label or by a keyword.
    const search = screen.getByRole('combobox', { name: 'Search' });
    fireEvent.change(search, { target: { value: 'done' } });
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(within(list).getByText('No matches')).toBeVisible();
    fireEvent.change(search, { target: { value: 'res' } });

    fireEvent.click(within(list).getByRole('option', { name: 'Resolved' }));
    expect(onChange).toHaveBeenCalledWith('resolved');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /^Status:\s*Resolved/ })).toBeVisible();
  });

  it('chooses with the keyboard: arrows to move, Enter to choose, Escape to close', async () => {
    const onChange = vi.fn();
    render(<Single onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /^Status:/ }));
    const search = await screen.findByRole('combobox', { name: 'Search' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('resolved');

    fireEvent.click(screen.getByRole('button', { name: /^Status:/ }));
    const again = await screen.findByRole('combobox', { name: 'Search' });
    fireEvent.keyDown(again, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  });

  it('stays open for several toggles when multiple, and offers to create what matches nothing', async () => {
    const onToggle = vi.fn();
    const onCreate = vi.fn();
    render(
      <Combobox
        multiple
        fieldLabel="Tags"
        listLabel="Tags"
        searchPlaceholder="Search or create"
        emptyText="No matches"
        selectedText="Selected"
        options={[
          { value: 'vip', label: 'vip' },
          { value: 'billing', label: 'billing' },
        ]}
        values={['vip']}
        onToggle={onToggle}
        onCreate={onCreate}
        createLabel={(text) => `Create tag “${text}”`}
      >
        vip
      </Combobox>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Tags:/ }));
    const list = await screen.findByRole('listbox', { name: 'Tags' });
    fireEvent.click(within(list).getByRole('option', { name: 'billing' }));
    expect(onToggle).toHaveBeenCalledWith('billing');
    expect(screen.getByRole('listbox', { name: 'Tags' })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Search or create' }), {
      target: { value: 'urgent' },
    });
    fireEvent.click(await screen.findByRole('option', { name: 'Create tag “urgent”' }));
    expect(onCreate).toHaveBeenCalledWith('urgent');
  });

  it('does not offer to create a tag that already exists', async () => {
    render(
      <Combobox
        multiple
        fieldLabel="Tags"
        listLabel="Tags"
        searchPlaceholder="Search or create"
        emptyText="No matches"
        selectedText="Selected"
        options={[{ value: 'vip', label: 'vip' }]}
        values={[]}
        onToggle={() => undefined}
        onCreate={() => undefined}
        createLabel={(text) => `Create tag “${text}”`}
      >
        none
      </Combobox>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Tags:/ }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Search or create' }), {
      target: { value: 'VIP' },
    });
    expect(screen.queryByRole('option', { name: /Create tag/ })).not.toBeInTheDocument();
  });
});

describe('Toaster', () => {
  it('shows a message with an action in a named region', async () => {
    const undo = vi.fn();
    render(<Toaster regionLabel="Notifications" />);
    act(() => {
      toast('Status set to Resolved', { action: { label: 'Undo', onClick: undo } });
    });
    expect(await screen.findByText('Status set to Resolved')).toBeVisible();
    expect(screen.getByRole('region', { name: /^Notifications/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledTimes(1);
  });
});
