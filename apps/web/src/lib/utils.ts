import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The web client's small, dependency-free helpers.
 *
 * Anything that formats a *domain* value — bytes, durations, relative times, addresses —
 * lives in `@platter/shared` instead, so a byte count reads identically in a toast, a log
 * line and an audit sentence. What is here is browser-only: class merging, timing, the
 * clipboard, and the one time format the shared package cannot own because it exists purely
 * to sit in a `title` attribute.
 */

/**
 * tailwind-merge only knows the *stock* Tailwind scales, and it resolves a conflict by
 * deciding which group a class belongs to. Every scale this design system renames therefore
 * has to be declared here or the merge silently does the wrong thing — and it fails
 * destructively, not harmlessly:
 *
 * - `text-subhead` looks like a colour to the stock config (only t-shirt sizes are font
 *   sizes), so `cn('text-primary-foreground', 'text-subhead')` **deleted** the foreground
 *   token and every primary and destructive button in the app rendered a near-black label
 *   on a near-black pill.
 * - `rounded-button` matches no group at all, so it never displaced the `rounded-lg` in
 *   `buttonVariants`' base and the 32px pill this system is built around rendered at 8px
 *   everywhere.
 *
 * Keep this list in step with the `@theme` block in `styles/global.css`: a name added there
 * and not here is a merge bug waiting to happen.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'display',
            'title-1',
            'title-2',
            'title-3',
            'headline',
            'body',
            'callout',
            'subhead',
            'footnote',
            'caption',
            'caption-2',
          ],
        },
      ],
      rounded: [{ rounded: ['card', 'button', 'pill'] }],
      shadow: [{ shadow: ['1', '2', '3', '4', 'nav'] }],
      ease: [{ ease: ['standard', 'out-expo'] }],
    },
  },
});

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

// ---------------------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------------------

export interface Cancellable {
  /** Drop any pending trailing call. Safe to call more than once. */
  cancel: () => void;
}

/**
 * Trailing-edge debounce: the wrapped function runs `waitMs` after the *last* call.
 *
 * Used for anything driven by typing — a search box must not issue a request per keystroke.
 * The returned function carries `.cancel()` so an unmounting component can drop a pending
 * call rather than setting state on a dead tree.
 */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number,
): ((...args: Args) => void) & Cancellable {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const debounced = (...args: Args): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, waitMs);
  };

  debounced.cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  return debounced;
}

/**
 * Leading-and-trailing throttle: runs immediately, then at most once per `waitMs`, and
 * always once more after the last call inside a window.
 *
 * The trailing edge is the part that matters for the console. A server that logs a burst
 * and then falls silent must still flush that burst — a leading-only throttle would render
 * the first line of the burst and drop the rest until the next line arrived, which for a
 * crashed server is never.
 *
 * The most recent arguments win: an intermediate call inside the window is superseded, not
 * queued.
 */
export function throttle<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number,
): ((...args: Args) => void) & Cancellable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastRunAt = 0;
  let pendingArgs: Args | undefined;

  const run = (args: Args): void => {
    lastRunAt = Date.now();
    pendingArgs = undefined;
    fn(...args);
  };

  const throttled = (...args: Args): void => {
    const elapsed = Date.now() - lastRunAt;

    if (elapsed >= waitMs && timer === undefined) {
      run(args);
      return;
    }

    pendingArgs = args;
    if (timer !== undefined) return;

    timer = setTimeout(
      () => {
        timer = undefined;
        if (pendingArgs !== undefined) run(pendingArgs);
      },
      Math.max(0, waitMs - elapsed),
    );
  };

  throttled.cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pendingArgs = undefined;
  };

  return throttled;
}

/** Exported for tests and for the console's reconnect copy; see `backoffDelay`. */
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CEILING_MS = 30_000;

/**
 * Exponential backoff with full jitter, for reconnect loops.
 *
 * The jitter is not decoration. When an API restarts, every open console in every browser
 * reconnects on the same schedule and stampedes it back down; randomising each client's
 * delay across the whole window is what spreads that load out. Capped at 30s so a console
 * left open overnight still recovers promptly once the node returns.
 */
export function backoffDelay(attempt: number): number {
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt), BACKOFF_CEILING_MS);
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

// ---------------------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------------------

/**
 * Write `value` to the clipboard, reporting honestly whether it worked.
 *
 * Copying is the one interaction that silently does nothing when it fails, so every failure
 * path is explicit. `navigator.clipboard` is unavailable in a non-secure context — which is
 * exactly how a self-hosted panel on a LAN often runs, over plain `http://` — and can be
 * refused by permissions or by a cross-origin iframe. The deprecated `execCommand` path is
 * kept deliberately: it is the only clipboard API that works over `http://`.
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Permission denied, or a non-secure context. The legacy path below may still work.
  }

  if (typeof document === 'undefined') return false;

  const staging = document.createElement('textarea');
  try {
    staging.value = value;
    staging.setAttribute('readonly', '');
    staging.style.position = 'fixed';
    staging.style.top = '0';
    staging.style.opacity = '0';
    document.body.appendChild(staging);
    staging.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    staging.remove();
  }
}

// ---------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------

/**
 * The full, unambiguous timestamp that sits in a `title` next to a relative time.
 *
 * `formatRelativeTime` from `@platter/shared` is what people read; this is what they check
 * when "3 days ago" is not precise enough — a backup they need to match against a log, or
 * an audit entry in an incident timeline. Includes the timezone, because a self-hosted
 * panel is routinely read by people in a different one from the node.
 */
export function absoluteTime(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZoneName: 'short',
  });
}
