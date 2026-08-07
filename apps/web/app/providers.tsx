'use client';

import { Theme } from '@astryxdesign/core';
import { LinkProvider } from '@astryxdesign/core/Link';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import NextLink from 'next/link';
import { createContext, type ReactNode, use, useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'platter.theme-mode';

export type ThemeMode = 'system' | 'light' | 'dark';

interface ThemeModeValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const ThemeModeContext = createContext<ThemeModeValue>({
  mode: 'system',
  setMode: () => undefined,
});

export function useThemeMode(): ThemeModeValue {
  return use(ThemeModeContext);
}

/**
 * Astryx handles light/dark entirely through the `<Theme>` provider's `mode` prop — there is no
 * class on `<html>` to toggle, so the mode has to live in React state. That means the first
 * server-rendered paint cannot know the user's stored choice.
 *
 * Rather than blocking render or flashing, this starts in `system` (which follows the OS and is
 * right for most people) and upgrades to the stored preference on mount. `system` is also what
 * the server renders, so the two agree and there is no hydration mismatch.
 *
 * `LinkProvider` routes every link inside an Astryx component through Next's `Link`, so
 * navigation stays client-side without each call site remembering to pass `as={Link}`.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('system');

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      setModeState(stored);
    }
    // Keep multiple tabs in agreement.
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY && event.newValue) {
        setModeState(event.newValue as ThemeMode);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    window.localStorage.setItem(STORAGE_KEY, next);
    setModeState(next);
  }, []);

  return (
    <ThemeModeContext value={{ mode, setMode }}>
      <Theme theme={neutralTheme} mode={mode}>
        <LinkProvider component={NextLink}>{children}</LinkProvider>
      </Theme>
    </ThemeModeContext>
  );
}
