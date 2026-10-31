import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Alert } from './alert.js';
import { Input, Select, Textarea } from './field.js';
import { Skeleton } from './skeleton.js';

describe('form fields', () => {
  it('render native controls that keep their accessible name and attributes', () => {
    render(
      <>
        <Input aria-label="Email" type="email" defaultValue="a@b.co" />
        <Select aria-label="Role" defaultValue="b">
          <option value="a">A</option>
          <option value="b">B</option>
        </Select>
        <Textarea aria-label="Body" rows={6} />
      </>,
    );
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveAttribute('type', 'email');
    expect(screen.getByRole('combobox', { name: 'Role' })).toHaveValue('b');
    expect(screen.getByRole('textbox', { name: 'Body' })).toHaveAttribute('rows', '6');
  });

  it('merges a caller class with the base class', () => {
    render(<Input aria-label="x" className="w-full" />);
    expect(screen.getByRole('textbox')).toHaveClass('w-full', 'h-control');
  });
});

describe('Alert', () => {
  it('announces an error at once and other tones politely, each with an icon', () => {
    const { container, rerender } = render(<Alert tone="error" title="Failed" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Failed');
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    rerender(
      <Alert tone="info" title="FYI">
        Details
      </Alert>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Details');
  });
});

describe('Skeleton', () => {
  it('is hidden from assistive technology', () => {
    const { container } = render(<Skeleton className="h-4" />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});
