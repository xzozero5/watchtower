import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Breadcrumb } from './breadcrumb.js';
import { Button } from './button.js';
import { DataTable, type DataTableColumn } from './data-table.js';
import { Dialog, DialogContent, DialogTrigger } from './dialog.js';
import { Sheet, SheetContent, SheetTrigger } from './sheet.js';
import { AUTONOMY_STAGES, StageBadge } from './stage-badge.js';

describe('Dialog', () => {
  it('is a named, described modal; Esc closes it and focus returns to the trigger', async () => {
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open</Button>
        </DialogTrigger>
        <DialogContent
          title="Stop all AI runs?"
          description="No drafts until you resume."
          closeLabel="Close"
          footer={<Button>Stop</Button>}
        >
          <label>
            Reason
            <input />
          </label>
        </DialogContent>
      </Dialog>,
    );
    const trigger = screen.getByRole('button', { name: 'Open' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Stop all AI runs?' });
    expect(dialog).toHaveAccessibleDescription('No drafts until you resume.');
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeVisible();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });
});

describe('Sheet', () => {
  it('is a right-hand modal with its own title, footer and close button', () => {
    render(
      <Sheet>
        <SheetTrigger asChild>
          <Button>Edit</Button>
        </SheetTrigger>
        <SheetContent
          title="Edit organization"
          description="Changes are saved when you press Save."
          closeLabel="Close"
          footer={<Button variant="primary">Save</Button>}
        >
          <p>Body</p>
        </SheetContent>
      </Sheet>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const sheet = screen.getByRole('dialog', { name: 'Edit organization' });
    expect(sheet).toHaveClass('right-0');
    expect(within(sheet).getByRole('button', { name: 'Save' })).toBeVisible();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Breadcrumb', () => {
  it('links every item but the last, which is the current page', () => {
    render(
      <Breadcrumb
        label="Breadcrumb"
        items={[
          { label: 'Admin', href: '/admin' },
          { label: 'Organizations', href: '/admin/orgs' },
          { label: 'Acme Logistics' },
        ]}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Admin', 'Organizations']);
    expect(within(nav).getByText('Acme Logistics')).toHaveAttribute('aria-current', 'page');
  });

  it('lets the app render its own links', () => {
    render(
      <Breadcrumb
        label="Breadcrumb"
        items={[{ label: 'Admin', href: '/admin' }, { label: 'Users' }]}
        renderLink={(item, className) => (
          <a href={item.href} data-custom className={className}>
            {item.label}
          </a>
        )}
      />,
    );
    expect(screen.getByRole('link', { name: 'Admin' })).toHaveAttribute('data-custom');
  });
});

describe('StageBadge', () => {
  it('shows an icon and words for each stage, and nothing above stage 3', () => {
    const labels = [
      'Stage 0 · Observe',
      'Stage 1 · Suggest',
      'Stage 2 · Draft for approval',
      'Stage 3 · Sends on its own',
    ];
    const { container } = render(
      <>
        {AUTONOMY_STAGES.map((stage) => (
          <StageBadge key={stage} stage={stage} label={labels[stage] ?? ''} />
        ))}
      </>,
    );
    for (const label of labels) expect(screen.getByText(label)).toBeVisible();
    expect(container.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(4);
    expect(AUTONOMY_STAGES).toEqual([0, 1, 2, 3]);
  });
});

interface Person {
  id: string;
  name: string;
  open: number;
}
const PEOPLE: Person[] = [
  { id: 'a', name: 'Mana K.', open: 9 },
  { id: 'b', name: 'Pim S.', open: 4 },
  { id: 'c', name: 'Dao N.', open: 12 },
];
const COLUMNS: DataTableColumn<Person>[] = [
  { id: 'name', header: 'Name', cell: (row) => row.name, sortValue: (row) => row.name },
  { id: 'open', header: 'Open', cell: (row) => row.open, sortValue: (row) => row.open },
  {
    id: 'actions',
    header: 'Actions',
    hideHeader: true,
    cell: (row) => <button type="button">Edit {row.name}</button>,
  },
];

const bodyRows = () => screen.getAllByRole('row').slice(1);
const key = (element: Element, name: string) => {
  fireEvent.keyDown(element, { key: name });
};

describe('DataTable', () => {
  it('has a caption, column headers and one row per item', () => {
    render(<DataTable caption="People" columns={COLUMNS} rows={PEOPLE} getRowId={(r) => r.id} />);
    const table = screen.getByRole('table', { name: 'People' });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(3);
    expect(within(table).getAllByRole('row')).toHaveLength(4);
  });

  it('sorts by a column and says so with aria-sort', () => {
    render(<DataTable caption="People" columns={COLUMNS} rows={PEOPLE} getRowId={(r) => r.id} />);
    const header = screen.getByRole('columnheader', { name: /Open/ });
    expect(header).toHaveAttribute('aria-sort', 'none');
    fireEvent.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    const names = () => bodyRows().map((row) => within(row).getAllByRole('cell')[0]?.textContent);
    expect(names()).toEqual(['Pim S.', 'Mana K.', 'Dao N.']);
    fireEvent.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(names()).toEqual(['Dao N.', 'Mana K.', 'Pim S.']);
    // The actions column is not sortable, so it carries no aria-sort.
    expect(screen.getByRole('columnheader', { name: 'Actions' })).not.toHaveAttribute('aria-sort');
  });

  it('keeps one tab stop and moves the row focus with arrows, J and K, Home and End', () => {
    const onActivate = vi.fn();
    render(
      <DataTable
        caption="People"
        columns={COLUMNS}
        rows={PEOPLE}
        getRowId={(r) => r.id}
        vimKeys
        onRowActivate={onActivate}
      />,
    );
    expect(bodyRows().map((row) => row.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    bodyRows()[0]?.focus();
    key(document.activeElement ?? document.body, 'ArrowDown');
    expect(bodyRows()[1]).toHaveFocus();
    key(document.activeElement ?? document.body, 'j');
    expect(bodyRows()[2]).toHaveFocus();
    key(document.activeElement ?? document.body, 'k');
    expect(bodyRows()[1]).toHaveFocus();
    key(document.activeElement ?? document.body, 'Home');
    expect(bodyRows()[0]).toHaveFocus();
    key(document.activeElement ?? document.body, 'End');
    expect(bodyRows()[2]).toHaveFocus();
    // The focused row is now the tab stop.
    expect(bodyRows().map((row) => row.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);
    key(document.activeElement ?? document.body, 'Enter');
    expect(onActivate).toHaveBeenCalledWith(PEOPLE[2]);
  });

  it('does not treat J or K as navigation unless asked, and ignores keys inside a cell control', () => {
    render(<DataTable caption="People" columns={COLUMNS} rows={PEOPLE} getRowId={(r) => r.id} />);
    const rows = bodyRows();
    rows[0]?.focus();
    key(rows[0] as Element, 'j');
    expect(rows[0]).toHaveFocus();
    const button = screen.getByRole('button', { name: 'Edit Mana K.' });
    button.focus();
    key(button, 'ArrowDown');
    expect(button).toHaveFocus();
  });

  it('opens a row on click but not when the click lands on a control inside it', () => {
    const onActivate = vi.fn();
    render(
      <DataTable
        caption="People"
        columns={COLUMNS}
        rows={PEOPLE}
        getRowId={(r) => r.id}
        onRowActivate={onActivate}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Pim S.' }));
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Pim S.'));
    expect(onActivate).toHaveBeenCalledWith(PEOPLE[1]);
  });

  it('can hide the caption visually and keep it for screen readers', () => {
    render(
      <DataTable
        caption="People"
        captionHidden
        columns={COLUMNS}
        rows={PEOPLE}
        getRowId={(r) => r.id}
      />,
    );
    expect(screen.getByText('People', { selector: 'caption' })).toHaveClass('sr-only');
  });
});
