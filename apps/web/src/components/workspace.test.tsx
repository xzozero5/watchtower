import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SINGLE_KEY_STORAGE_KEY, resetPreferencesCache } from '@/lib/preferences';
import { renderWorkspace } from '@/test-utils';
import { makeInsight } from '@/test/ai-fixtures';
import { workspaceApi } from '@/test/scenarios';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }));

beforeEach(() => {
  localStorage.clear();
  resetPreferencesCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'matchMedia');
});

/** Makes the window `width` px wide for the layout hook (jsdom has no media queries). */
function stubViewport(width: number) {
  const px = (query: string) => {
    const rem = /min-width:\s*([\d.]+)rem/.exec(query)?.[1];
    return rem ? Number(rem) * 16 : 0;
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: width >= px(query),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

async function openWorkspace(options: Parameters<typeof renderWorkspace>[0] = {}) {
  const view = renderWorkspace(options);
  await screen.findByRole('region', { name: 'Queue' });
  await screen.findByRole('option', { name: /OPS-1|Customer subject 1/ });
  return view;
}

/** A key that is not a character (F6, Alt+digit), sent to whatever has focus. */
const sendKey = (init: KeyboardEventInit) => {
  fireEvent.keyDown(document.activeElement ?? document.body, init);
};
const f6 = (shiftKey = false) => {
  sendKey({ key: 'F6', code: 'F6', shiftKey });
};
const alt = (digit: 1 | 2 | 3) => {
  // The character differs by layout; the physical key is what counts.
  sendKey({ key: '๑', code: `Digit${String(digit)}`, altKey: true });
};
const pane = (name: string) => screen.getByRole('region', { name });

/** Opens the account menu and returns its single-key item (Radix menus ignore jsdom clicks on items). */
async function singleKeyItem(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^(Account menu|เมนูบัญชี)$/ }));
  return screen.findByRole('menuitemcheckbox', { name: /Single-key shortcuts|คีย์ลัดปุ่มเดี่ยว/ });
}
async function toggleSingleKey(user: ReturnType<typeof userEvent.setup>) {
  const item = await singleKeyItem(user);
  item.focus();
  await user.keyboard('{Enter}');
}
/** The listbox that holds the keyboard: the board's section with the open ticket (id queue-listbox). */
const listbox = () => {
  const found = document.getElementById('queue-listbox');
  if (!found) throw new Error('no active listbox');
  return found;
};

describe('single-key shortcuts preference (WCAG 2.1.4)', () => {
  it('turns every single-character shortcut off, keeps Ctrl+K and the buttons, and is saved', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    await user.click(screen.getByRole('option', { name: /OPS-1/ }));
    await screen.findByRole('textbox', { name: 'Public reply' });

    await toggleSingleKey(user);
    expect(localStorage.getItem(SINGLE_KEY_STORAGE_KEY)).toBe('off');

    await user.keyboard('j');
    expect(screen.getByRole('option', { name: /OPS-1/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: /OPS-2/ })).toHaveAttribute('aria-selected', 'false');
    await user.keyboard('k');
    expect(screen.getByRole('option', { name: /OPS-1/ })).toHaveAttribute('aria-selected', 'true');

    // "[[" types a literal "[" in user-event's key syntax.
    for (const key of ['c', 'n', 's', '/', '?', '[[', ']', 'o']) {
      await user.keyboard(key);
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search tickets' })).not.toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'Public reply' })).not.toHaveFocus();
    expect(screen.getByRole('button', { name: 'Collapse the queue' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await user.keyboard('gq');
    expect(listbox()).not.toHaveFocus();

    // Ctrl+K is not a single-character shortcut: it still works.
    fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // So do F6 (from the top bar it goes to the first pane) and the buttons.
    f6();
    await waitFor(() => {
      expect(listbox()).toHaveFocus();
    });
    await user.click(screen.getByRole('button', { name: /Show keyboard shortcuts/ }));
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('remembers the choice after a reload', async () => {
    const user = userEvent.setup();
    workspaceApi();
    const first = await openWorkspace();
    await toggleSingleKey(user);
    first.unmount();

    resetPreferencesCache();
    workspaceApi();
    await openWorkspace();
    const again = userEvent.setup();
    expect(await singleKeyItem(again)).toHaveAttribute('aria-checked', 'false');
    await again.keyboard('{Escape}');
    await again.keyboard('j');
    expect(within(listbox()).queryByRole('option', { selected: true })).not.toBeInTheDocument();
  });

  it('can be switched from the command palette, and ? works again when it is on', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();

    fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', ctrlKey: true });
    await user.type(
      await screen.findByRole('combobox', { name: 'Command palette' }),
      'single-key shortcuts: turn off',
    );
    await user.keyboard('{Enter}');
    expect(localStorage.getItem(SINGLE_KEY_STORAGE_KEY)).toBe('off');
    await user.keyboard('?');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', ctrlKey: true });
    await user.type(
      await screen.findByRole('combobox', { name: 'Command palette' }),
      'single-key shortcuts: turn on',
    );
    await user.keyboard('{Enter}');
    await user.keyboard('?');
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('is reflected in the keyboard map: switch, notice and "off" on the keys it disables', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    await user.keyboard('?');
    let dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByRole('checkbox', { name: 'Single-key shortcuts' })).toBeChecked();
    expect(within(dialog).queryByText('Single-key shortcuts are off')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('(off)')).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('checkbox', { name: 'Single-key shortcuts' }));
    dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('Single-key shortcuts are off')).toBeVisible();
    const row = (id: string) => dialog.querySelector(`[data-keymap-id="${id}"]`) as HTMLElement;
    expect(within(row('next')).getByText('(off)')).toBeVisible();
    expect(within(row('help')).getByText('(off)')).toBeVisible();
    // Modifier and function keys are not affected.
    expect(within(row('palette')).queryByText('(off)')).not.toBeInTheDocument();
    expect(within(row('panesCycle')).queryByText('(off)')).not.toBeInTheDocument();
  });
});

describe('keyboard map by permission', () => {
  it('shows an agent the note, status and AI keys', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    for (const label of [
      'Write an internal note',
      'Change the status of the open ticket',
      'Approve the AI draft (opens a preview)',
      'Go to the queue',
    ]) {
      expect(within(dialog).getByText(label)).toBeVisible();
    }
  });

  it('hides the note, status and AI keys from a customer', async () => {
    const user = userEvent.setup();
    workspaceApi({ role: 'client' });
    await openWorkspace();
    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('Write a public reply')).toBeVisible();
    expect(within(dialog).getByText('Next ticket')).toBeVisible();
    for (const label of [
      'Write an internal note',
      'Change the status of the open ticket',
      'Approve the AI draft (opens a preview)',
      'Edit the AI draft',
      'Reject the AI draft',
      'Collapse or expand the details panel',
    ]) {
      expect(within(dialog).queryByText(label)).not.toBeInTheDocument();
    }
    expect(within(dialog).queryByText('AI drafts (Phase 1)')).not.toBeInTheDocument();
  });
});

describe('moving between panes', () => {
  it('F6 and Shift+F6 cycle the panes, Alt+1/2/3 jump to one', async () => {
    workspaceApi();
    await openWorkspace();

    f6();
    // The queue's focus target is its list.
    await waitFor(() => {
      expect(listbox()).toHaveFocus();
    });
    f6();
    await waitFor(() => {
      expect(pane('Conversation')).toHaveFocus();
    });
    f6();
    await waitFor(() => {
      expect(pane('Details & AI')).toHaveFocus();
    });
    f6();
    await waitFor(() => {
      expect(listbox()).toHaveFocus();
    });
    f6(true);
    await waitFor(() => {
      expect(pane('Details & AI')).toHaveFocus();
    });

    alt(2);
    await waitFor(() => {
      expect(pane('Conversation')).toHaveFocus();
    });
    alt(3);
    await waitFor(() => {
      expect(pane('Details & AI')).toHaveFocus();
    });
    alt(1);
    await waitFor(() => {
      expect(listbox()).toHaveFocus();
    });
  });

  it('works from inside a text field and on a Thai layout', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    await user.click(screen.getByRole('searchbox', { name: 'Search tickets' }));
    alt(2);
    await waitFor(() => {
      expect(pane('Conversation')).toHaveFocus();
    });
  });

  it('shows the focused pane with a ring', async () => {
    workspaceApi();
    await openWorkspace();
    alt(2);
    await waitFor(() => {
      expect(pane('Conversation')).toHaveFocus();
    });
    expect(pane('Conversation').className).toContain('focus-visible:outline-2');
  });

  it('a customer has two panes: Alt+3 does nothing and F6 cycles between the two', async () => {
    workspaceApi({ role: 'client' });
    await openWorkspace();
    alt(3);
    expect(document.body).toHaveFocus();
    alt(2);
    await waitFor(() => {
      expect(pane('Conversation')).toHaveFocus();
    });
    f6();
    await waitFor(() => {
      expect(listbox()).toHaveFocus();
    });
  });

  it('Enter on the list and O open the ticket and move focus into the conversation', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();

    await user.keyboard('j');
    expect(listbox()).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(pane('Conversation')).toHaveFocus();
    });
    expect(await screen.findByRole('heading', { name: 'Cannot log in', level: 3 })).toBeVisible();

    // O does the same from anywhere outside a field.
    alt(1);
    await waitFor(() => {
      expect(listbox()).toHaveFocus();
    });
    await user.keyboard('j');
    await user.keyboard('o');
    await waitFor(() => {
      expect(pane('Conversation')).toHaveFocus();
    });
    expect(await screen.findByRole('heading', { name: 'Export is slow', level: 3 })).toBeVisible();
  });

  it('O does nothing without an open ticket, and Enter on an empty selection does nothing', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    await user.keyboard('o');
    expect(pane('Conversation')).not.toHaveFocus();
    listbox().focus();
    await user.keyboard('{Enter}');
    expect(pane('Conversation')).not.toHaveFocus();
  });

  it('arrow keys, Home and End move through the list while it has focus', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    listbox().focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: /OPS-1/ })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: /OPS-2/ })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(screen.getByRole('option', { name: /OPS-3/ })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Home}');
    expect(screen.getByRole('option', { name: /OPS-1/ })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('option', { name: /OPS-1/ })).toHaveAttribute('aria-selected', 'true');
    expect(listbox()).toHaveAttribute('aria-activedescendant', 'queue-row-OPS-1');
  });

  it('the queue is a listbox of options; only the open ticket is selected', async () => {
    workspaceApi();
    await openWorkspace();
    expect(listbox()).toHaveAttribute('tabindex', '0');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options.every((option) => option.getAttribute('aria-selected') === 'false')).toBe(true);
    expect(listbox()).not.toHaveAttribute('aria-activedescendant');
  });

  it('[ and ] collapse and expand the side panes, with a button for each and focus kept', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    const queueButton = () => screen.getByRole('button', { name: /^(Collapse|Expand) the queue$/ });
    const assistantButton = () =>
      screen.getByRole('button', { name: /^(Collapse|Expand) the details panel$/ });
    expect(queueButton()).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('[[');
    expect(queueButton()).toHaveAttribute('aria-expanded', 'false');
    expect(queueButton()).toHaveAccessibleName('Expand the queue');
    await waitFor(() => {
      expect(queueButton()).toHaveFocus();
    });
    expect(document.getElementById('pane-queue')?.parentElement?.className).toContain(
      'lg:grid-cols-[48px_minmax(0,1fr)_clamp(272px,22vw,320px)]',
    );

    await user.keyboard(']');
    expect(assistantButton()).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('pane-queue')?.parentElement?.className).toContain(
      'lg:grid-cols-[48px_minmax(0,1fr)_48px]',
    );

    // Alt+1 expands the queue again and focuses its list.
    alt(1);
    await waitFor(() => {
      expect(listbox()).toHaveFocus();
    });
    expect(queueButton()).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard(']');
    expect(assistantButton()).toHaveAttribute('aria-expanded', 'true');
    await user.click(queueButton());
    expect(queueButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('skips a collapsed pane when cycling', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    await user.keyboard('[[');
    alt(2);
    await waitFor(() => {
      expect(pane('Conversation')).toHaveFocus();
    });
    f6();
    await waitFor(() => {
      expect(pane('Details & AI')).toHaveFocus();
    });
    f6();
    // Back to the conversation, not the collapsed queue.
    await waitFor(() => {
      expect(pane('Conversation')).toHaveFocus();
    });
  });

  it('g then q goes to the queue; the other g keys are listed but not wired', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    alt(2);
    await waitFor(() => {
      expect(pane('Conversation')).toHaveFocus();
    });
    await user.keyboard('gq');
    await waitFor(() => {
      expect(listbox()).toHaveFocus();
    });

    alt(3);
    await waitFor(() => {
      expect(pane('Details & AI')).toHaveFocus();
    });
    await user.keyboard('go');
    expect(pane('Details & AI')).toHaveFocus();
  });

  it('ignores [ ] and g q typed into a field', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    await user.type(screen.getByRole('searchbox', { name: 'Search tickets' }), '[[]gq');
    expect(screen.getByRole('searchbox', { name: 'Search tickets' })).toHaveValue('[]gq');
    expect(screen.getByRole('button', { name: 'Collapse the queue' })).toBeInTheDocument();
  });

  it('matches the physical key on a Thai layout', async () => {
    workspaceApi();
    await openWorkspace();
    fireEvent.keyDown(document.body, { key: 'บ', code: 'BracketLeft' });
    expect(screen.getByRole('button', { name: 'Expand the queue' })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'บ', code: 'BracketLeft' });
    fireEvent.keyDown(document.body, { key: '๊', code: 'KeyG' });
    fireEvent.keyDown(document.body, { key: 'ๆ', code: 'KeyQ' });
    await waitFor(() => {
      expect(listbox()).toHaveFocus();
    });
  });
});

describe('768 to 1023 px', () => {
  it('] opens and closes the AI drawer', async () => {
    const user = userEvent.setup();
    stubViewport(900);
    workspaceApi();
    await openWorkspace();
    const toggle = screen.getByRole('button', { name: 'Details & AI' });
    await user.keyboard(']');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('Alt+3 opens the drawer; F6 skips it while it is closed', async () => {
    stubViewport(900);
    workspaceApi();
    await openWorkspace();
    alt(2);
    await waitFor(() => {
      expect(pane('Conversation')).toHaveFocus();
    });
    f6();
    await waitFor(() => {
      expect(listbox()).toHaveFocus();
    });
    alt(3);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Close the details panel' })).toHaveFocus();
    });
  });
});

describe('under 768 px: one pane at a time', () => {
  const tab = (name: string) => screen.getByRole('tab', { name });

  it('offers tabs for Queue, Conversation and AI assistant, starting on the queue', async () => {
    stubViewport(375);
    workspaceApi();
    await openWorkspace();
    expect(screen.getByRole('tablist', { name: 'Panes' })).toBeInTheDocument();
    const paneTabs = () =>
      within(screen.getByRole('tablist', { name: 'Panes' })).getAllByRole('tab');
    expect(paneTabs().map((t) => t.textContent)).toEqual(['Queue', 'Conversation', 'Details & AI']);
    expect(tab('Queue')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Queue')).toHaveAttribute('aria-controls', 'pane-queue');
    expect(tab('Conversation')).toHaveAttribute('aria-selected', 'false');
    // Only the chosen pane is shown below 768 px.
    expect(document.getElementById('pane-queue')?.className).not.toContain('max-md:hidden');
    expect(document.getElementById('pane-conversation')?.className).toContain('max-md:hidden');
    expect(document.getElementById('pane-assistant')?.className).toContain('max-md:hidden');
    // The tab strip itself exists only on phones.
    expect(screen.getByRole('tablist', { name: 'Panes' }).className).toContain('md:hidden');
    expect(tab('Queue').className).toContain('min-h-[44px]');
  });

  it('tapping a ticket opens the Conversation tab and moves focus there', async () => {
    const user = userEvent.setup();
    stubViewport(375);
    workspaceApi();
    await openWorkspace();
    await user.click(screen.getByRole('option', { name: /OPS-2/ }));
    expect(tab('Conversation')).toHaveAttribute('aria-selected', 'true');
    expect(document.getElementById('pane-conversation')?.className).not.toContain('max-md:hidden');
    expect(document.getElementById('pane-queue')?.className).toContain('max-md:hidden');
    await waitFor(() => {
      expect(pane('Conversation')).toHaveFocus();
    });
    expect(await screen.findByRole('heading', { name: 'Export is slow', level: 3 })).toBeVisible();

    // Back to the queue with its tab; the list is still there with the ticket marked.
    await user.click(tab('Queue'));
    expect(screen.getByRole('option', { name: /OPS-2/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens on the Conversation tab when the address names a ticket', async () => {
    stubViewport(375);
    window.history.replaceState(null, '', '/?ticket=OPS-1');
    workspaceApi();
    renderWorkspace();
    await screen.findByRole('region', { name: 'Conversation' });
    expect(tab('Conversation')).toHaveAttribute('aria-selected', 'true');
  });

  it('moves between tabs with the arrow keys, Home and End (roving tabindex)', async () => {
    const user = userEvent.setup();
    stubViewport(375);
    workspaceApi();
    await openWorkspace();
    expect(tab('Queue')).toHaveAttribute('tabindex', '0');
    expect(tab('Conversation')).toHaveAttribute('tabindex', '-1');
    tab('Queue').focus();
    await user.keyboard('{ArrowRight}');
    expect(tab('Conversation')).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => {
      expect(tab('Conversation')).toHaveFocus();
    });
    await user.keyboard('{End}');
    expect(tab('Details & AI')).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(tab('Queue')).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowLeft}');
    expect(tab('Details & AI')).toHaveAttribute('aria-selected', 'true');
  });

  it('F6 and Alt+n switch tabs', async () => {
    stubViewport(375);
    workspaceApi();
    await openWorkspace();
    alt(3);
    expect(tab('Details & AI')).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => {
      expect(pane('Details & AI')).toHaveFocus();
    });
    f6();
    expect(tab('Queue')).toHaveAttribute('aria-selected', 'true');
    f6();
    expect(tab('Conversation')).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps Approve / Edit / Reject with the draft: sticky at the bottom with 44 px targets', async () => {
    const user = userEvent.setup();
    stubViewport(375);
    workspaceApi({ ai: { 'OPS-1': makeInsight() } });
    await openWorkspace();
    // There is no separate bar any more, and nothing to act on before a ticket is open.
    expect(screen.queryByRole('group', { name: 'Draft actions' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('option', { name: /OPS-1/ }));
    const bar = await screen.findByRole('group', { name: 'Draft actions' });
    expect(bar.className).toContain('max-md:sticky');
    expect(bar.className).toContain('max-md:bottom-0');
    const buttons = within(bar).getAllByRole('button');
    // Approve keeps its word and icon; Edit and Reject are round icon buttons named by aria-label.
    expect(buttons.map((button) => button.getAttribute('aria-keyshortcuts'))).toEqual([
      'A',
      'E',
      'R',
    ]);
    expect(buttons.map((button) => button.textContent)).toEqual(['Approve', '', '']);
    expect(
      buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent),
    ).toEqual(['Approve', 'Edit', 'Reject']);
    for (const button of buttons) {
      expect(button.className).toContain('max-md:min-h-[44px]');
      expect(button.className).toContain('max-md:min-w-[44px]');
    }

    // On the Queue tab the conversation, with its draft, is hidden.
    await user.click(tab('Queue'));
    expect(screen.getByRole('region', { name: 'Conversation', hidden: true }).className).toContain(
      'max-md:hidden',
    );
  });

  it('a customer gets two tabs and no draft', async () => {
    const user = userEvent.setup();
    stubViewport(375);
    workspaceApi({ role: 'client' });
    await openWorkspace();
    expect(
      within(screen.getByRole('tablist', { name: 'Panes' }))
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Queue', 'Conversation']);
    await user.click(tab('Conversation'));
    expect(screen.queryByRole('group', { name: 'Draft actions' })).not.toBeInTheDocument();
  });

  it('J and K still move through the list without leaving the Queue tab', async () => {
    const user = userEvent.setup();
    stubViewport(375);
    workspaceApi();
    await openWorkspace();
    await user.keyboard('jj');
    expect(screen.getByRole('option', { name: /OPS-2/ })).toHaveAttribute('aria-selected', 'true');
    expect(tab('Queue')).toHaveAttribute('aria-selected', 'true');
  });
});

describe('navigation rail', () => {
  it('is 56 px of icons and expands to 220 px with Ctrl+B, announcing the state', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    const rail = screen.getByRole('banner');
    expect(rail.className).toContain('md:w-[56px]');
    const toggle = screen.getByRole('button', { name: 'Expand the navigation' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.keyDown(document.body, { key: 'b', code: 'KeyB', ctrlKey: true });
    expect(rail.className).toContain('md:w-[220px]');
    expect(screen.getByRole('button', { name: 'Collapse the navigation' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Collapse the navigation' }));
    expect(rail.className).toContain('md:w-[56px]');
  });

  it('gives every icon a tooltip with its shortcut, on keyboard focus too', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    await user.tab();
    screen.getByRole('button', { name: 'Open command palette' }).focus();
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Open command palette');
    expect(tip).toHaveTextContent('Ctrl');
    expect(tip).toHaveTextContent('K');
  });

  it('links the shift screens for staff, keeps notifications disabled, and shows nothing for a customer', async () => {
    workspaceApi();
    const view = await openWorkspace();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).getByRole('button', { name: 'Queue' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Daily brief' })).toHaveAttribute(
      'href',
      '/shift/brief',
    );
    expect(within(nav).getByRole('link', { name: 'Shift handoff' })).toHaveAttribute(
      'href',
      '/shift/handoff',
    );
    expect(within(nav).getByRole('link', { name: 'My shift' })).toHaveAttribute('href', '/shift');
    expect(within(nav).getByRole('button', { name: 'Notifications' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    view.unmount();

    workspaceApi({ role: 'client' });
    await openWorkspace();
    expect(screen.queryByRole('link', { name: 'Daily brief' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'My shift' })).not.toBeInTheDocument();
  });

  it('moves live and API status into the rail without losing their words', async () => {
    workspaceApi();
    await openWorkspace();
    expect(screen.getByTestId('live-status')).toHaveTextContent(/Live|Connecting/);
    expect(screen.getByTestId('api-status')).toHaveAttribute('data-state');
  });
});

describe('ticket header', () => {
  it('sits outside the scrolling area, so scrolling to the newest message cannot hide it', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    await user.click(screen.getByRole('option', { name: /OPS-1/ }));
    const heading = await screen.findByRole('heading', { name: 'Cannot log in', level: 3 });
    const header = heading.closest('header');
    expect(header).not.toBeNull();
    expect(header?.closest('.overflow-y-auto')).toBeNull();
    expect(header?.className).toContain('shrink-0');
  });
});

describe('Thai copy for the new controls', () => {
  it('has the panes label, tabs and the preference in Thai', async () => {
    stubViewport(375);
    workspaceApi();
    renderWorkspace({ locale: 'th' });
    await screen.findByRole('region', { name: 'คิวงาน' });
    expect(screen.getByRole('tablist', { name: 'พาเนล' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'รายละเอียดและ AI' })).toBeInTheDocument();
    expect(await singleKeyItem(userEvent.setup())).toHaveAttribute('aria-checked', 'true');
  });
});
