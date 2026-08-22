import { useState } from 'react';
import { ChevronDown } from 'pixelarticons/react/ChevronDown.js';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Keeps the settings that can break a server out of the first screen.
 *
 * Most people running a server for friends never need to think about memory ceilings, JVM
 * flags or a reinstall, and showing all of it at once makes the page read as something you
 * need to understand before you touch it. Closed by default, one click away, and never a
 * different shape from the field-level disclosure in `variable-fields.tsx` — two controls
 * that mean "there is more here" should not look like two different ideas.
 */

export interface AdvancedDisclosureProps {
  /** Shown on the button, after the word Advanced. Usually a count. */
  summary?: string;
  children: React.ReactNode;
  className?: string;
}

export function AdvancedDisclosure({ summary, children, className }: AdvancedDisclosureProps) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button
        aria-expanded={false}
        className={cn(
          'h-11 w-fit rounded-button px-4 text-subhead font-medium text-label-secondary',
          className,
        )}
        onClick={() => setOpen(true)}
        variant="ghost"
      >
        <ChevronDown aria-hidden />
        {summary === undefined ? 'Advanced' : `Advanced (${summary})`}
      </Button>
    );
  }

  return <div className={cn('flex flex-col gap-6', className)}>{children}</div>;
}
