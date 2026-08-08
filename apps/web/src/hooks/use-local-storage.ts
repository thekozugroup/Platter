import { useCallback, useEffect, useState } from 'react';

type SetValue<T> = T | ((previous: T) => T);

function resolveInitial<T>(initialValue: T | (() => T)): T {
  return typeof initialValue === 'function' ? (initialValue as () => T)() : initialValue;
}

function readStorage<T>(key: string, initialValue: T | (() => T)): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw !== null ? (JSON.parse(raw) as T) : resolveInitial(initialValue);
  } catch {
    // Malformed JSON left by an older build, or storage disabled (private browsing) —
    // either way, the initial value is the honest fallback.
    return resolveInitial(initialValue);
  }
}

/**
 * Persisted UI state (a chosen tab, a "don't show this again", a draft) that also stays in
 * sync across tabs of the same origin via the `storage` event. Not a cache for server data
 * — that is what React Query and the hooks around it are for.
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T | (() => T),
): [T, (value: SetValue<T>) => void, () => void] {
  const [storedValue, setStoredValue] = useState<T>(() => readStorage(key, initialValue));

  const setValue = useCallback(
    (value: SetValue<T>) => {
      setStoredValue((previous) => {
        const next = typeof value === 'function' ? (value as (previous: T) => T)(previous) : value;
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // Storage full or unavailable — the in-memory value still updates for this tab.
        }
        return next;
      });
    },
    [key],
  );

  const remove = useCallback(() => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
    setStoredValue(resolveInitial(initialValue));
    // `initialValue` intentionally excluded from deps: an inline literal or arrow function
    // passed at the call site would otherwise re-identify on every render and make this
    // callback (and anything depending on it) unstable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== key || event.storageArea !== window.localStorage) return;
      if (event.newValue === null) {
        setStoredValue(resolveInitial(initialValue));
        return;
      }
      try {
        setStoredValue(JSON.parse(event.newValue) as T);
      } catch {
        // Another tab wrote something unparsable; keep what we have.
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return [storedValue, setValue, remove];
}
