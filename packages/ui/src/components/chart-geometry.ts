/**
 * Pure geometry for the SVG charts, kept apart from React so it can be tested with numbers
 * (dataviz marks-and-anatomy: bars at most 24 px thick, a 2 px surface gap, a 4 px rounded data end
 * and a square baseline).
 */

/** The thickest a bar may be: the band's leftover is air, never a bigger bar. */
export const BAR_MAX_THICKNESS = 24;
/** The surface gap between two adjacent bars. */
export const BAR_GAP = 2;
/** Radius of the rounded data end. */
export const BAR_RADIUS = 4;

const NICE_STEPS = [1, 2, 4, 6, 8, 10] as const;

/**
 * The top of a count axis: the smallest clean number at or above the largest value. 0 and 1 give 1,
 * so an all-zero chart still has a 0 baseline and a 1 above it.
 */
export function niceCeil(max: number): number {
  const target = Math.max(1, Math.ceil(max));
  if (target <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  for (const step of NICE_STEPS) {
    const candidate = step * magnitude;
    if (candidate >= target) return candidate;
  }
  return 10 * magnitude;
}

/** Whole-number ticks from 0 to the top of the axis: two when it is tiny, otherwise three. */
export function countTicks(top: number): number[] {
  if (top <= 2) return Array.from({ length: top + 1 }, (_, index) => index);
  return [0, top / 2, top];
}

/**
 * The columns that get an x label, counted back from the last one so the newest is always named.
 * `minSpacing` is the room one label needs in pixels.
 */
export function labelIndexes(count: number, plotWidth: number, minSpacing: number): number[] {
  if (count <= 0) return [];
  const fit = Math.max(1, Math.floor(plotWidth / minSpacing));
  const step = Math.max(1, Math.ceil(count / fit));
  const indexes: number[] = [];
  for (let index = count - 1; index >= 0; index -= step) indexes.push(index);
  return indexes.reverse();
}

export interface ColumnLayout {
  /** Width of one slot (a bar and the air around it). */
  slot: number;
  /** Width of the bar itself. */
  thickness: number;
}

/** A bar never fills its slot: it leaves the surface gap and stops at the thickness cap. */
export function columnLayout(count: number, plotWidth: number): ColumnLayout {
  const slot = count > 0 ? plotWidth / count : plotWidth;
  const thickness = Math.min(BAR_MAX_THICKNESS, Math.max(1, slot - BAR_GAP));
  return { slot, thickness };
}

const n = (value: number) => String(Math.round(value * 100) / 100);

/** A vertical bar from the baseline up to `y`: 4 px rounded at the top, square on the baseline. */
export function columnPath(
  x: number,
  y: number,
  width: number,
  height: number,
  rounded = true,
): string {
  const r = rounded ? Math.max(0, Math.min(BAR_RADIUS, width / 2, height)) : 0;
  if (r === 0) return `M${n(x)} ${n(y + height)}H${n(x + width)}V${n(y)}H${n(x)}Z`;
  return [
    `M${n(x)} ${n(y + height)}`,
    `V${n(y + r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}`,
    `H${n(x + width - r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(x + width)} ${n(y + r)}`,
    `V${n(y + height)}`,
    'Z',
  ].join('');
}

/** A horizontal bar from the baseline on the left: 4 px rounded on the right, square on the left. */
export function rowPath(x: number, y: number, width: number, height: number): string {
  const r = Math.max(0, Math.min(BAR_RADIUS, height / 2, width));
  if (r === 0) return `M${n(x)} ${n(y)}H${n(x + width)}V${n(y + height)}H${n(x)}Z`;
  return [
    `M${n(x)} ${n(y)}`,
    `H${n(x + width - r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(x + width)} ${n(y + r)}`,
    `V${n(y + height - r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(x + width - r)} ${n(y + height)}`,
    `H${n(x)}`,
    'Z',
  ].join('');
}

/**
 * The slot a pointer is over, from its x inside the plot. Clamped, so the gap between two bars and
 * the air at either end still answer with the nearest bar: the hit area is the whole slot.
 */
export function slotAt(x: number, count: number, plotWidth: number): number {
  if (count <= 0) return -1;
  const slot = plotWidth / count;
  return Math.min(count - 1, Math.max(0, Math.floor(x / slot)));
}
