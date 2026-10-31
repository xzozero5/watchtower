'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * `value`, but a change shows up at most once every `intervalMs`. The first change is applied at
 * once; changes inside the window are held and the latest one is applied when the window ends.
 * When `immediate(value)` is true the change skips the wait: the "N new" pill uses it to clear the
 * announcement the moment the count drops to zero.
 */
export function useThrottledValue<T>(
  value: T,
  intervalMs: number,
  immediate?: (value: T) => boolean,
): T {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  const lastChange = useRef<number>(Number.NEGATIVE_INFINITY);
  const immediateRef = useRef(immediate);
  useEffect(() => {
    immediateRef.current = immediate;
  });

  useEffect(() => {
    if (Object.is(value, shownRef.current)) return;
    const wait = immediateRef.current?.(value)
      ? 0
      : Math.max(0, lastChange.current + intervalMs - Date.now());
    const timer = setTimeout(() => {
      shownRef.current = value;
      lastChange.current = Date.now();
      setShown(value);
    }, wait);
    return () => {
      clearTimeout(timer);
    };
  }, [value, intervalMs]);

  return shown;
}
