import { QueryClientProvider } from '@tanstack/react-query';
import { useMemo } from 'react';
import { RouterProvider } from 'react-router';
import { AppErrorBoundary } from '@/components/layout/error-boundary';
import { Toaster } from '@/components/ui/toast';
import { AuthProvider } from '@/lib/auth.js';
import { createQueryClient } from '@/lib/query.js';
import { createRouter } from '@/routes.js';
import { ThemeProvider } from '@/lib/theme.js';

/**
 * Application root.
 *
 * Provider order matters and is not arbitrary: the error boundary is outermost so a crash
 * inside any provider still renders a page; theme sits above everything that paints; the
 * query client is above auth because signing in and out clears the cache; and the router is
 * innermost so every route guard can read the session.
 */
export function App() {
  // Created once per mount rather than at module scope, so tests get a clean cache.
  const queryClient = useMemo(() => createQueryClient(), []);
  const router = useMemo(() => createRouter(), []);

  return (
    <AppErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <RouterProvider router={router} />
            <Toaster />
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </AppErrorBoundary>
  );
}
