import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';
import { AVATAR_HUE_COUNT } from '../tokens/colors.js';

export const AVATAR_SIZES = [20, 24, 32] as const;
export type AvatarSize = (typeof AVATAR_SIZES)[number];

// Full class names, so Tailwind can see them when it scans this file. One per hue in colors.ts.
const HUES = [
  'bg-avatar-1-bg text-avatar-1-fg',
  'bg-avatar-2-bg text-avatar-2-fg',
  'bg-avatar-3-bg text-avatar-3-fg',
  'bg-avatar-4-bg text-avatar-4-fg',
  'bg-avatar-5-bg text-avatar-5-fg',
  'bg-avatar-6-bg text-avatar-6-fg',
  'bg-avatar-7-bg text-avatar-7-fg',
  'bg-avatar-8-bg text-avatar-8-fg',
] as const;

const SIZE: Record<AvatarSize, string> = {
  20: 'size-5 text-[10px]',
  24: 'size-6 text-[11px]',
  32: 'size-8 text-xs',
};

/** Thai leading vowels are written before the consonant they follow; the initial is the consonant. */
const THAI_LEADING_VOWEL = /^[เแโใไ]/u;

function firstLetter(word: string): string {
  const letters = Array.from(word.replace(THAI_LEADING_VOWEL, (v) => (word.length > 1 ? '' : v)));
  return letters[0] ?? '';
}

/**
 * One or two capital letters for a person's name: the first letters of the first and last words
 * ("Alex Agent" gives "AA"), or the first letter of a single word. Empty for an empty name.
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const first = words[0];
  if (!first) return '';
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const text = `${firstLetter(first)}${last ? firstLetter(last) : ''}`;
  return text.toLocaleUpperCase();
}

/** A stable hue from 1 to 8 for an id (or any string): the same person always gets the same colour. */
export function avatarHue(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return (hash % AVATAR_HUE_COUNT) + 1;
}

export interface AvatarProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  name: string;
  /** Stable identifier that picks the hue. Defaults to the name. */
  id?: string;
  size?: AvatarSize;
  /**
   * Draw the initials from an attribute instead of as text. For a button whose accessible name
   * already holds the person's name: the initials then are not part of the button's visible text,
   * which keeps the name containing the visible words (WCAG 2.5.3).
   */
  drawInitials?: boolean;
}

/**
 * Initials on a muted hue. Never a remote image (privacy, and no network request per person). It
 * is decorative because the name always sits next to it; give it an `aria-label` where it does not.
 */
export function Avatar({
  name,
  id,
  size = 24,
  drawInitials = false,
  className,
  ...props
}: AvatarProps) {
  const labelled = props['aria-label'] !== undefined;
  return (
    <span
      data-hue={avatarHue(id ?? name)}
      aria-hidden={labelled ? undefined : true}
      role={labelled ? 'img' : undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-medium ring-2 ring-background select-none',
        SIZE[size],
        HUES[avatarHue(id ?? name) - 1],
        drawInitials && 'after:content-[attr(data-initials)]',
        className,
      )}
      {...(drawInitials ? { 'data-initials': initialsOf(name) } : {})}
      {...props}
    >
      {drawInitials ? null : initialsOf(name)}
    </span>
  );
}
