import { useCallback, useEffect, useRef, useState } from 'react';
import { Check } from 'pixelarticons/react/Check.js';
import { Close } from 'pixelarticons/react/Close.js';
import { Copy } from 'pixelarticons/react/Copy.js';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn, copyToClipboard } from '@/lib/utils';

/**
 * A monospace value with a copy button — addresses, ports, ids, tokens.
 *
 * Copying is the one interaction in this app that silently does nothing when it fails, so
 * the failure path is explicit. `copyToClipboard` (in `lib/utils.ts`) owns the mechanics and
 * the `http://` fallback; this component owns saying so when they do not work.
 */

type CopyState = 'idle' | 'copied' | 'failed';

export interface CopyFieldProps {
  /** The exact text placed on the clipboard. */
  value: string;
  /** Names the value for assistive tech: "Server address", "API token". Required. */
  label: string;
  /** Shown instead of `value` when the full string is too long to display. */
  display?: string;
  /** Renders `label` above the field. Off by default — most call sites already label the row. */
  showLabel?: boolean;
  /** `boxed` draws a bordered field; `inline` is bare text plus the button. */
  variant?: 'boxed' | 'inline';
  size?: 'sm' | 'md';
  className?: string;
}

export function CopyField({
  value,
  label,
  display,
  showLabel = false,
  variant = 'boxed',
  size = 'md',
  className,
}: CopyFieldProps) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async () => {
    const ok = await copyToClipboard(value);
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), ok ? 2000 : 6000);
  }, [value]);

  const Icon = state === 'copied' ? Check : state === 'failed' ? Close : Copy;

  return (
    <div
      aria-label={label}
      className={cn('flex min-w-0 flex-col gap-1', className)}
      role="group"
    >
      {showLabel ? (
        <span className="text-caption font-medium text-label-tertiary">{label}</span>
      ) : null}

      <div
        className={cn(
          'flex min-w-0 items-center gap-1',
          variant === 'boxed' &&
            'rounded-sm border border-separator-strong bg-bg-sunken ps-3 pe-1 py-1',
        )}
      >
        <code
          className={cn(
            'min-w-0 flex-1 truncate font-mono text-label-secondary',
            size === 'sm' ? 'text-caption' : 'text-footnote',
          )}
          title={value}
        >
          {display ?? value}
        </code>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={state === 'copied' ? `${label} copied` : `Copy ${label.toLowerCase()}`}
              className="hit-target size-8 shrink-0 text-label-tertiary hover:text-label"
              onClick={() => void copy()}
              size="icon-md"
              variant="ghost"
            >
              <Icon aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy {label.toLowerCase()}</TooltipContent>
        </Tooltip>
      </div>

      {/*
        One live region per field. It also carries the visible failure copy, because a
        clipboard write that quietly did nothing is indistinguishable from one that worked.
      */}
      <span
        aria-live="polite"
        className={cn(
          'text-caption',
          state === 'failed' ? 'text-danger' : 'sr-only',
        )}
        role="status"
      >
        {state === 'copied' ? `${label} copied` : null}
        {state === 'failed'
          ? 'Couldn’t reach the clipboard. Select the value and press Ctrl+C.'
          : null}
      </span>
    </div>
  );
}
