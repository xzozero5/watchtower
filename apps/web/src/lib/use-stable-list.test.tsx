import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { useStableList } from './use-stable-list';

function Harness({ initial }: { initial: string[] }) {
  const [items, setItems] = useState(initial);
  const stable = useStableList(items, (item) => item);
  return (
    <div>
      <button
        type="button"
        onClick={() => setItems(['c', ...items.filter((item) => item !== 'a')])}
      >
        change
      </button>
      <div data-testid="list" tabIndex={0} {...stable.handlers}>
        {stable.shown.join(',')}
      </div>
      <span data-testid="changed">{stable.changed}</span>
      <button type="button" onClick={stable.apply}>
        apply
      </button>
    </div>
  );
}

describe('useStableList', () => {
  it('follows the data while nobody is interacting with the list', () => {
    render(<Harness initial={['a', 'b']} />);
    fireEvent.click(screen.getByText('change'));
    expect(screen.getByTestId('list')).toHaveTextContent('c,b');
    expect(screen.getByTestId('changed')).toHaveTextContent('0');
  });

  it('freezes the list under the pointer, counts what changed, and catches up on leaving', () => {
    render(<Harness initial={['a', 'b']} />);
    const list = screen.getByTestId('list');
    fireEvent.pointerEnter(list);
    fireEvent.click(screen.getByText('change'));
    expect(list).toHaveTextContent('a,b');
    // One item left, one arrived.
    expect(screen.getByTestId('changed')).toHaveTextContent('2');
    fireEvent.pointerLeave(list);
    expect(list).toHaveTextContent('c,b');
    expect(screen.getByTestId('changed')).toHaveTextContent('0');
  });

  it('also freezes while focus is inside, and "." or apply shows the latest', () => {
    render(<Harness initial={['a', 'b']} />);
    const list = screen.getByTestId('list');
    act(() => {
      list.focus();
    });
    fireEvent.click(screen.getByText('change'));
    expect(list).toHaveTextContent('a,b');
    expect(screen.getByTestId('changed')).toHaveTextContent('2');
    fireEvent.keyDown(document.body, { key: '.', code: 'Period' });
    expect(list).toHaveTextContent('c,b');
    expect(screen.getByTestId('changed')).toHaveTextContent('0');
  });
});
