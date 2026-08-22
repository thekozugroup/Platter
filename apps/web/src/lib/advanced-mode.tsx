import { createContext, useCallback, useContext, useMemo, useState } from 'react';

/**
 * Easy mode is the product's default posture, and advanced mode is one switch away.
 *
 * Platter is for people who have not run a server before. Every extra control on a screen is
 * something they have to decide is not their problem, and a few of them — heap size, JVM
 * flags, port allocations — can stop a server booting if guessed at. So the whole app starts
 * simple and the operator opts into the rest, once, rather than opening a disclosure on every
 * screen and having it closed again on the next visit.
 *
 * A preference, not a role. It says "show me more", never "let me do more": advanced mode
 * grants no permission and hides nothing dangerous. What it must not do is hide the only path
 * to something — see `AdvancedOnly`, whose `force` prop exists because a field with a
 * validation error, or a setting already changed from its default, has to be visible whatever
 * mode the app is in. Hiding a problem is worse than showing a hard control.
 *
 * Stored per browser rather than per account: it describes how this person wants to read the
 * app, and it must be right on first paint, before any request has resolved.
 */

const STORAGE_KEY = 'platter.advanced-mode';

interface AdvancedModeContextValue {
  /** True when the operator has asked to see everything. */
  advanced: boolean;
  setAdvanced: (next: boolean) => void;
}

const AdvancedModeContext = createContext<AdvancedModeContextValue | null>(null);

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    // Private modes can throw. Easy mode is the safe answer to "I do not know".
    return false;
  }
}

export function AdvancedModeProvider({ children }: { children: React.ReactNode }) {
  const [advanced, setAdvancedState] = useState<boolean>(readStored);

  const setAdvanced = useCallback((next: boolean) => {
    setAdvancedState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
    } catch {
      // A preference that does not persist is a much smaller problem than a crash here.
    }
  }, []);

  const value = useMemo(() => ({ advanced, setAdvanced }), [advanced, setAdvanced]);

  return <AdvancedModeContext.Provider value={value}>{children}</AdvancedModeContext.Provider>;
}

export function useAdvancedMode(): AdvancedModeContextValue {
  const value = useContext(AdvancedModeContext);
  if (!value) throw new Error('useAdvancedMode must be used inside AdvancedModeProvider');
  return value;
}
