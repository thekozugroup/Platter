import { QueryClientProvider } from '@tanstack/react-query';
import { useMemo } from 'react';
import { createQueryClient } from '@/lib/query.js';
import { ThemeProvider } from '@/lib/theme.js';

/**
 * Application root.
 *
 * The router, auth provider and screens are layered in on top of this shell; it exists
 * separately so that providers are established exactly once, above anything that might
 * suspend or throw.
 */
export function App() {
  // Created once per mount rather than at module scope, so tests get a clean cache.
  const queryClient = useMemo(() => createQueryClient(), []);

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <main className="mx-auto flex min-h-svh max-w-[--pl-container-max] flex-col items-start justify-center gap-4 px-6">
          <h1 className="text-[length:--pl-text-display]">Platter</h1>
          <p className="text-muted-foreground text-[length:--pl-text-body-lg]">
            Simple, clean, easily deployable game servers.
          </p>
        </main>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
