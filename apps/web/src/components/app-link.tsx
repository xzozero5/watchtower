'use client';

import { useRouter } from 'next/navigation';
import type { AnchorHTMLAttributes, MouseEvent } from 'react';

/**
 * A real link (middle click, "open in new tab" and the status-bar address all work) that moves
 * through the app router on a plain left click, so the shell and its caches stay mounted.
 */
export function AppLink({
  href,
  onClick,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const router = useRouter();
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (props.target && props.target !== '_self') return;
    event.preventDefault();
    router.push(href);
  };
  return <a href={href} onClick={handle} {...props} />;
}
