import type { HTMLAttributes, SVGProps } from 'react';

import { cn } from '../lib/cn.js';

export const BIRDDAY_STATES = ['idle', 'thinking', 'speaking', 'paused', 'offline'] as const;
export type BirddayState = (typeof BIRDDAY_STATES)[number];

export const BIRDDAY_SIZES = ['xs', 'sm', 'md', 'lg'] as const;
export type BirddaySize = (typeof BIRDDAY_SIZES)[number];

export interface BirddayIconProps extends SVGProps<SVGSVGElement> {
  /** Optional mood cue on the compact icon (`sleeping` closes the eye). */
  sleeping?: boolean;
}

/**
 * Birdday — Watchtower's open-source cockatiel AI mascot (compact vector mark).
 *
 * Palette stays strictly outside alert coral (`#e5594a`) so it never reads as severity P1:
 * golden crest (`#fbbf24` / `#f59e0b`), warm lemon head (`#fef3c7` / `#fde68a`),
 * pearl-slate plumage (`#cbd5e1` / `#94a3b8`), and signature apricot cheek (`#fb923c`).
 */
export function BirddayIcon({ sleeping = false, className, ...props }: BirddayIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden={props['aria-label'] ? undefined : true}
      data-slot="birdday-icon"
      className={cn('shrink-0 select-none', className)}
      {...props}
    >
      {/* Swept golden cockatiel crest plumes */}
      <path d="M11.6 7.4C10.9 4.5 8.8 2.4 6.1 2.1C8.1 3.7 9.1 5.6 9.2 7.8Z" fill="#f59e0b" />
      <path d="M13.2 7.2C13.1 4.1 11.4 1.9 8.9 1.3C10.5 3.1 11.2 5.1 11.0 7.4Z" fill="#fbbf24" />
      {/* Pearl-grey cockatiel body & folded wing */}
      <path
        d="M6.6 14.2C6.6 10.6 9.3 8.2 12.8 8.2C15.9 8.2 18.1 10.4 18.1 13.5C18.1 17.3 15.3 20.6 11.1 21.3L8.2 21.7C7.3 21.8 6.7 21.0 7.1 20.2L8.1 18.2C7.1 17.1 6.6 15.7 6.6 14.2Z"
        fill="#cbd5e1"
      />
      <path
        d="M8.6 14.8C9.2 12.8 11.2 11.8 13.3 12.3C14.8 12.7 15.8 14.1 15.6 15.8C15.3 18.1 13.1 19.8 10.2 20.1C9.0 18.7 8.3 16.7 8.6 14.8Z"
        fill="#94a3b8"
      />
      {/* Warm lemon-cream cockatiel head */}
      <circle cx="13.2" cy="11.2" r="4.9" fill="#fef3c7" />
      <path
        d="M9.4 12.4C9.1 10.0 10.9 7.8 13.3 7.8C15.6 7.8 17.5 9.6 17.6 11.9C16.5 10.6 14.9 9.9 13.1 9.9C11.4 9.9 10.1 10.9 9.4 12.4Z"
        fill="#fde68a"
        opacity="0.65"
      />
      {/* Curved cockatiel beak */}
      <path
        d="M17.6 10.7C19.4 10.9 20.6 12.0 20.5 13.5C19.5 13.3 18.5 13.0 17.5 12.6Z"
        fill="#475569"
      />
      <path
        d="M17.5 12.3C18.4 12.6 19.1 13.0 19.5 13.6C18.6 13.9 17.8 13.7 17.3 13.1Z"
        fill="#64748b"
      />
      {/* Signature apricot-orange cockatiel cheek patch */}
      <circle cx="12.5" cy="12.9" r="1.65" fill="#fb923c" opacity="0.92" />
      {/* Expressive eye */}
      {sleeping ? (
        <path
          d="M13.7 10.6C14.1 11.2 14.9 11.2 15.3 10.6"
          stroke="#0f172a"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      ) : (
        <>
          <circle cx="14.6" cy="10.4" r="1.15" fill="#0f172a" />
          <circle cx="14.95" cy="10.05" r="0.42" fill="#ffffff" />
        </>
      )}
    </svg>
  );
}

const AVATAR_SHELL_SIZES: Record<BirddaySize, string> = {
  xs: 'size-6',
  sm: 'size-8',
  md: 'size-10',
  lg: 'size-14',
};

const AVATAR_SVG_SIZES: Record<BirddaySize, string> = {
  xs: 'size-4.5',
  sm: 'size-6',
  md: 'size-7.5',
  lg: 'size-11',
};

export interface BirddayAvatarProps extends HTMLAttributes<HTMLSpanElement> {
  /** Activity mood of Birdday. */
  state?: BirddayState;
  /** Medallion size (`xs` 24px, `sm` 32px, `md` 40px, `lg` 56px). */
  size?: BirddaySize;
  /** Accessible label if used standalone; omit when adjacent text already names Birdday. */
  label?: string;
}

/**
 * Expressive cockatiel medallion for chat turns, panel header, floating launcher, and empty states.
 * Respects `prefers-reduced-motion` via `motion-safe:` utilities.
 */
export function BirddayAvatar({
  state = 'idle',
  size = 'md',
  label,
  className,
  ...props
}: BirddayAvatarProps) {
  const sleeping = state === 'paused' || state === 'offline';
  const thinking = state === 'thinking';
  const speaking = state === 'speaking';

  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-slot="birdday-avatar"
      data-bird-state={state}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-full border select-none',
        sleeping
          ? 'border-border bg-surface-muted/90 opacity-80'
          : 'border-ai-accent/25 bg-ai-subtle shadow-2xs',
        thinking && 'ring-2 ring-ai-accent/30',
        AVATAR_SHELL_SIZES[size],
        className,
      )}
      {...props}
    >
      <svg
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden
        className={cn(
          AVATAR_SVG_SIZES[size],
          state === 'idle' && 'motion-safe:animate-bird-bob',
          thinking && 'motion-safe:animate-bird-think',
          speaking && 'motion-safe:animate-bird-speak',
        )}
      >
        {/* Animated cockatiel crest group */}
        <g className={cn('origin-[16px_11px]', !sleeping && 'motion-safe:animate-crest-wiggle')}>
          <path
            d={
              sleeping
                ? 'M15.2 10.6C13.6 8.2 10.8 7.0 7.9 7.4C10.2 8.4 11.8 9.6 12.6 11.2Z'
                : 'M15.0 10.2C14.0 6.2 11.3 3.4 7.7 3.0C10.4 5.1 11.7 7.6 11.9 10.6Z'
            }
            fill="#f59e0b"
          />
          <path
            d={
              sleeping
                ? 'M17.2 10.2C16.1 7.6 13.7 6.0 10.9 6.0C12.8 7.3 14.0 8.9 14.4 10.6Z'
                : 'M17.4 9.9C17.2 5.6 14.9 2.7 11.6 1.9C13.7 4.3 14.7 7.0 14.4 10.1Z'
            }
            fill="#fbbf24"
          />
          {!sleeping ? (
            <path
              d="M19.0 10.1C19.4 6.9 18.0 4.4 15.6 3.3C16.9 5.3 17.3 7.5 16.8 10.0Z"
              fill="#fde68a"
            />
          ) : null}
        </g>

        {/* Pearl-grey cockatiel chest & wing */}
        <path
          d="M8.8 19.2C8.8 14.4 12.4 11.2 17.1 11.2C21.2 11.2 24.2 14.1 24.2 18.3C24.2 23.4 20.4 27.7 14.8 28.7L11.0 29.2C9.8 29.4 9.0 28.3 9.5 27.2L10.9 24.5C9.5 23.1 8.8 21.2 8.8 19.2Z"
          fill="#cbd5e1"
        />
        <path
          d="M11.4 20.0C12.2 17.3 14.9 16.0 17.7 16.7C19.7 17.2 21.1 19.1 20.8 21.4C20.4 24.4 17.5 26.7 13.6 27.1C12.0 25.2 11.0 22.6 11.4 20.0Z"
          fill="#94a3b8"
        />
        {/* Wing white feather trim */}
        <path
          d="M12.7 19.8C13.6 18.2 15.6 17.5 17.4 18.1"
          stroke="#f8fafc"
          strokeWidth="1.2"
          strokeLinecap="round"
          opacity="0.85"
        />

        {/* Warm lemon-cream cockatiel head */}
        <circle cx="17.6" cy="15.1" r="6.5" fill="#fef3c7" />
        <path
          d="M12.5 16.7C12.1 13.5 14.5 10.6 17.7 10.6C20.8 10.6 23.3 13.0 23.5 16.0C22.0 14.3 19.9 13.4 17.5 13.4C15.2 13.4 13.5 14.7 12.5 16.7Z"
          fill="#fde68a"
          opacity="0.7"
        />

        {/* Beak (cheerfully open when speaking) */}
        {speaking ? (
          <>
            <path
              d="M23.4 14.1C25.9 14.2 27.5 15.4 27.5 17.1C26.1 16.9 24.7 16.6 23.3 16.1Z"
              fill="#475569"
            />
            <path
              d="M23.2 16.4C24.6 16.9 25.7 17.7 26.0 18.7C24.7 19.0 23.5 18.5 22.9 17.5Z"
              fill="#64748b"
            />
          </>
        ) : (
          <>
            <path
              d="M23.4 14.4C25.8 14.7 27.4 16.1 27.3 18.1C25.9 17.9 24.6 17.5 23.3 16.9Z"
              fill="#475569"
            />
            <path
              d="M23.3 16.5C24.5 16.9 25.4 17.5 25.9 18.3C24.7 18.7 23.7 18.4 23.0 17.6Z"
              fill="#64748b"
            />
          </>
        )}

        {/* Signature apricot-orange cockatiel cheek patch */}
        <circle cx="16.7" cy="17.4" r="2.25" fill="#fb923c" opacity="0.92" />

        {/* Eye */}
        {sleeping ? (
          <path
            d="M18.3 14.3C18.9 15.2 20.0 15.2 20.6 14.3"
            stroke="#0f172a"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        ) : (
          <>
            <circle cx="19.5" cy="14.0" r="1.5" fill="#0f172a" />
            <circle cx="20.0" cy="13.5" r="0.55" fill="#ffffff" />
          </>
        )}

        {/* Thinking sparkles */}
        {thinking ? (
          <g fill="#0f766e">
            <circle cx="25.5" cy="7.5" r="1.15" className="motion-safe:animate-pulse" />
            <circle
              cx="28.2"
              cy="4.8"
              r="1.45"
              className="motion-safe:animate-pulse"
              style={{ animationDelay: '180ms' }}
            />
          </g>
        ) : null}

        {/* Sleeping 'z' cue */}
        {sleeping ? (
          <path
            d="M23.5 6.5H26.8L23.5 9.8H26.8"
            stroke="#64748b"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </svg>
    </span>
  );
}
