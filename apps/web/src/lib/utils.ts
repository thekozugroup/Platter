import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names, letting later Tailwind utilities win over earlier conflicting ones.
 * Plain `clsx` would keep both `px-2` and `px-4` and leave the winner to source order,
 * which makes component variants unpredictable from the outside.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Coalesce rapid calls; used for search fields and resize handlers. */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number,
): ((...args: Args) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: Args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return wrapped;
}

/** Leading-edge throttle, for streams that fire faster than a frame (log lines, stats). */
export function throttle<Args extends unknown[]>(
  fn: (...args: Args) => void,
  intervalMs: number,
): (...args: Args) => void {
  let last = 0;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  return (...args: Args) => {
    const now = Date.now();
    const remaining = intervalMs - (now - last);
    if (remaining <= 0) {
      if (trailing) {
        clearTimeout(trailing);
        trailing = undefined;
      }
      last = now;
      fn(...args);
    } else if (!trailing) {
      trailing = setTimeout(() => {
        last = Date.now();
        trailing = undefined;
        fn(...args);
      }, remaining);
    }
  };
}

/** Copy text, reporting whether it worked so the UI can avoid a lying "Copied!" toast. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Exponential backoff with full jitter, so reconnecting clients do not synchronise. */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 30_000): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(Math.random() * exponential);
}

/** `srv_01J8ZQ...` -> `srv_01J8ZQ` — enough to be recognisable, short enough to read. */
export function shortId(id: string, length = 8): string {
  const [prefix, body] = id.split('_');
  if (!body) return id.slice(0, length);
  return `${prefix}_${body.slice(0, length)}`;
}

/** Absolute timestamp for tooltips, where the relative form is too vague to act on. */
export function absoluteTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
