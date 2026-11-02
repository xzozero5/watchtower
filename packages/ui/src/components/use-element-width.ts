import { type RefObject, useEffect, useState } from 'react';

/**
 * The width of an element in CSS pixels, kept up to date with a ResizeObserver. Before it is
 * measured (server render, jsdom, first paint) it answers `fallback`, so a chart always has a size.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const read = () => {
      setWidth(Math.round(element.getBoundingClientRect().width));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return width > 0 ? width : fallback;
}
