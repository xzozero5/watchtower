import * as RadixSeparator from '@radix-ui/react-separator';
import type { ComponentProps } from 'react';

import { cn } from '../lib/cn.js';

/** A 1px hairline. Decorative by default, so screen readers skip it. */
export function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: ComponentProps<typeof RadixSeparator.Root>) {
  return (
    <RadixSeparator.Root
      orientation={orientation}
      decorative={decorative}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  );
}
