import type { SVGProps } from 'react';

import { cn } from '../lib/cn.js';

export type FlagCode = 'th' | 'gb';

/**
 * A flag as inline SVG, 20 x 14. Windows does not draw flag emoji, so the picture is drawn here
 * instead of relying on a font. The colours are the flags' own, a picture and not a status: the
 * red in them is the one exception to "red means P1" (docs/design/less-text-ai-assistant.md 1.3).
 * It is decoration: whatever uses it names the language in words. A hairline ring keeps the white
 * bands visible on a light surface.
 */
export function FlagIcon({
  code,
  className,
  ...props
}: { code: FlagCode } & Omit<SVGProps<SVGSVGElement>, 'viewBox' | 'children'>) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 20 14"
      width={20}
      height={14}
      className={cn('shrink-0 rounded-[2px] ring-1 ring-border-strong ring-inset', className)}
      {...props}
    >
      {code === 'th' ? <Thailand /> : <UnitedKingdom />}
    </svg>
  );
}

const RED = '#a51931';
const BLUE_TH = '#2d2a4a';
const BLUE_UK = '#012169';
const WHITE = '#ffffff';
const RED_UK = '#c8102e';

/** Five bands, 1 : 1 : 2 : 1 : 1 (red, white, blue, white, red). */
function Thailand() {
  return (
    <>
      <rect width="20" height="14" fill={RED} />
      <rect y="2.33" width="20" height="9.34" fill={WHITE} />
      <rect y="4.67" width="20" height="4.66" fill={BLUE_TH} />
    </>
  );
}

function UnitedKingdom() {
  return (
    <>
      <rect width="20" height="14" fill={BLUE_UK} />
      <path d="M0 0L20 14M20 0L0 14" stroke={WHITE} strokeWidth="2.8" />
      <path d="M0 0L20 14M20 0L0 14" stroke={RED_UK} strokeWidth="1" />
      <path d="M10 0V14M0 7H20" stroke={WHITE} strokeWidth="4.6" />
      <path d="M10 0V14M0 7H20" stroke={RED_UK} strokeWidth="2.6" />
    </>
  );
}
