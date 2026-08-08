import { useCallback, useSyncExternalStore } from 'react';

/**
 * A single media query, kept in sync with `useSyncExternalStore` rather than an
 * effect-driven `useState` — there is no tearing between renders, and no extra render just
 * to move off an `undefined` initial guess the way an effect-based version needs.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mediaQueryList = window.matchMedia(query);
      mediaQueryList.addEventListener('change', onChange);
      return () => mediaQueryList.removeEventListener('change', onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Motion must honour this — transform/opacity animations should collapse to an instant
 *  change rather than play when the visitor has asked their OS for less motion. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
