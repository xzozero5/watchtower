import type { TintId } from '../tokens/colors.js';

/**
 * Tailwind classes per tint family. Written out in full so Tailwind can see them when it scans
 * this file; the colours come from the `--wt-color-tint-*` tokens and follow the theme.
 */
export const TINT_CLASSES: Record<
  TintId,
  {
    readonly chip: string;
    readonly icon: string;
    readonly dot: string;
    /** Outlined, not filled: coloured text and a 1px ring in the icon hue (SLA timers). */
    readonly outline: string;
  }
> = {
  red: {
    chip: 'bg-tint-red-bg text-tint-red-fg',
    icon: 'text-tint-red-icon',
    dot: 'bg-tint-red-icon',
    outline: 'text-tint-red-fg ring-tint-red-icon',
  },
  amber: {
    chip: 'bg-tint-amber-bg text-tint-amber-fg',
    icon: 'text-tint-amber-icon',
    dot: 'bg-tint-amber-icon',
    outline: 'text-tint-amber-fg ring-tint-amber-icon',
  },
  sky: {
    chip: 'bg-tint-sky-bg text-tint-sky-fg',
    icon: 'text-tint-sky-icon',
    dot: 'bg-tint-sky-icon',
    outline: 'text-tint-sky-fg ring-tint-sky-icon',
  },
  slate: {
    chip: 'bg-tint-slate-bg text-tint-slate-fg',
    icon: 'text-tint-slate-icon',
    dot: 'bg-tint-slate-icon',
    outline: 'text-tint-slate-fg ring-tint-slate-icon',
  },
  green: {
    chip: 'bg-tint-green-bg text-tint-green-fg',
    icon: 'text-tint-green-icon',
    dot: 'bg-tint-green-icon',
    outline: 'text-tint-green-fg ring-tint-green-icon',
  },
  teal: {
    chip: 'bg-tint-teal-bg text-tint-teal-fg',
    icon: 'text-tint-teal-icon',
    dot: 'bg-tint-teal-icon',
    outline: 'text-tint-teal-fg ring-tint-teal-icon',
  },
  violet: {
    chip: 'bg-tint-violet-bg text-tint-violet-fg',
    icon: 'text-tint-violet-icon',
    dot: 'bg-tint-violet-icon',
    outline: 'text-tint-violet-fg ring-tint-violet-icon',
  },
  blue: {
    chip: 'bg-tint-blue-bg text-tint-blue-fg',
    icon: 'text-tint-blue-icon',
    dot: 'bg-tint-blue-icon',
    outline: 'text-tint-blue-fg ring-tint-blue-icon',
  },
  indigo: {
    chip: 'bg-tint-indigo-bg text-tint-indigo-fg',
    icon: 'text-tint-indigo-icon',
    dot: 'bg-tint-indigo-icon',
    outline: 'text-tint-indigo-fg ring-tint-indigo-icon',
  },
  purple: {
    chip: 'bg-tint-purple-bg text-tint-purple-fg',
    icon: 'text-tint-purple-icon',
    dot: 'bg-tint-purple-icon',
    outline: 'text-tint-purple-fg ring-tint-purple-icon',
  },
  pink: {
    chip: 'bg-tint-pink-bg text-tint-pink-fg',
    icon: 'text-tint-pink-icon',
    dot: 'bg-tint-pink-icon',
    outline: 'text-tint-pink-fg ring-tint-pink-icon',
  },
  orange: {
    chip: 'bg-tint-orange-bg text-tint-orange-fg',
    icon: 'text-tint-orange-icon',
    dot: 'bg-tint-orange-icon',
    outline: 'text-tint-orange-fg ring-tint-orange-icon',
  },
};
