import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderApp } from '@/test-utils';

import { CommandPalette } from './command-palette';
import type { Command } from './commands';
import { isPaletteShortcut, usePaletteShortcut } from './use-palette-shortcut';

const makeCommands = () => {
  const run = { dark: vi.fn(), light: vi.fn(), thai: vi.fn() };
  const commands: Command[] = [
    { id: 'dark', label: 'Theme: dark', group: 'display', keywords: ['theme'], run: run.dark },
    { id: 'light', label: 'Theme: light', group: 'display', keywords: ['theme'], run: run.light },
    { id: 'th', label: 'Language: Thai', group: 'language', keywords: ['ภาษา'], run: run.thai },
  ];
  return { commands, run };
};

function Harness({
  commands,
  initiallyOpen = true,
}: {
  commands: Command[];
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  usePaletteShortcut(() => {
    setOpen((value) => !value);
  });
  return <CommandPalette open={open} onOpenChange={setOpen} commands={commands} />;
}

describe('CommandPalette', () => {
  it('is a labelled dialog with a search field focused and every command listed', () => {
    const { commands } = makeCommands();
    renderApp(<Harness commands={commands} />);
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveFocus();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('filters as you type and shows an empty state when nothing matches', async () => {
    const user = userEvent.setup();
    const { commands } = makeCommands();
    renderApp(<Harness commands={commands} />);

    await user.type(screen.getByRole('combobox'), 'light');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('Theme: light'),
    ]);

    await user.clear(screen.getByRole('combobox'));
    await user.type(screen.getByRole('combobox'), 'zzz');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByText('No matching commands')).toBeVisible();
    expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-controls');
  });

  it('moves with the arrow keys, wraps, and runs the highlighted command on Enter', async () => {
    const user = userEvent.setup();
    const { commands, run } = makeCommands();
    renderApp(<Harness commands={commands} />);
    const input = screen.getByRole('combobox');

    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1]?.id);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Enter}');
    expect(run.thai).toHaveBeenCalledTimes(1);
    expect(run.dark).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('runs a command on click and closes', async () => {
    const user = userEvent.setup();
    const { commands, run } = makeCommands();
    renderApp(<Harness commands={commands} />);
    await user.click(screen.getByRole('option', { name: /Theme: light/ }));
    expect(run.light).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape without running anything', async () => {
    const user = userEvent.setup();
    const { commands, run } = makeCommands();
    renderApp(<Harness commands={commands} />);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(run.dark).not.toHaveBeenCalled();
  });

  it('forgets the previous query when it opens again', async () => {
    const user = userEvent.setup();
    const { commands } = makeCommands();
    renderApp(<Harness commands={commands} />);
    await user.type(screen.getByRole('combobox'), 'light');
    await user.keyboard('{Escape}');
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(await screen.findByRole('combobox')).toHaveValue('');
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('shows Thai text when the app language is Thai', () => {
    const { commands } = makeCommands();
    renderApp(<Harness commands={commands} />, { locale: 'th' });
    expect(screen.getByRole('dialog', { name: 'แผงคำสั่ง' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('พิมพ์คำสั่ง')).toBeInTheDocument();
  });
});

describe('Ctrl+K / Cmd+K', () => {
  it('opens and closes the palette from anywhere', () => {
    const { commands } = makeCommands();
    renderApp(<Harness commands={commands} initiallyOpen={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: 'K', metaKey: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stops the browser from handling the shortcut itself', () => {
    const { commands } = makeCommands();
    renderApp(<Harness commands={commands} initiallyOpen={false} />);
    const notCancelled = fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(notCancelled).toBe(false);
  });

  it('recognises only the real shortcut', () => {
    const base = { key: 'k', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
    expect(isPaletteShortcut({ ...base, ctrlKey: true })).toBe(true);
    expect(isPaletteShortcut({ ...base, metaKey: true })).toBe(true);
    expect(isPaletteShortcut({ ...base, key: 'K', ctrlKey: true })).toBe(true);
    expect(isPaletteShortcut(base)).toBe(false);
    expect(isPaletteShortcut({ ...base, ctrlKey: true, key: 'j' })).toBe(false);
    expect(isPaletteShortcut({ ...base, ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isPaletteShortcut({ ...base, ctrlKey: true, altKey: true })).toBe(false);
  });
});
