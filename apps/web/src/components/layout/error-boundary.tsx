import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link, isRouteErrorResponse, useRouteError } from 'react-router';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/common/error-state';
import { pageActionClass } from '@/components/layout/page-header';
import { cn } from '@/lib/utils';

/**
 * The last line of defence.
 *
 * A blank white page is an acceptable failure mode for a blog. It is not one for the screen
 * someone opened because their Minecraft server stopped responding — they need to know the
 * panel broke, not the server, and they need a way back in. So a render error still gets a
 * real page: what happened, the message, and two ways out.
 */

interface BoundaryProps {
  children: ReactNode;
  /** Where "Go back" points. Defaults to the dashboard. */
  homeTo?: string;
}

interface BoundaryState {
  error: Error | null;
}

function CrashScreen({ error, homeTo = '/' }: { error: Error; homeTo?: string }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 bg-bg px-6 py-16 text-center">
      <h1 className="text-title-1 text-label">This screen crashed</h1>
      <p className="max-w-prose text-balance text-body text-label-secondary">
        Platter hit a bug while drawing this page. Your servers are unaffected — nothing here talks
        to them until the page loads.
      </p>

      <pre className="max-w-full overflow-x-auto rounded-sm border border-separator-strong bg-bg-sunken px-4 py-3 text-start font-mono text-caption text-label-secondary">
        {error.message || 'Unknown error'}
      </pre>

      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <Button className={pageActionClass} onClick={() => window.location.reload()} size="lg">
          Reload the page
        </Button>
        <Button asChild className={cn(pageActionClass)} size="lg" variant="outline">
          <a href={homeTo}>Go to the dashboard</a>
        </Button>
      </div>

      <p className="mt-4 max-w-prose text-caption text-label-tertiary">
        If it happens again, the browser console holds the stack trace worth filing a bug with.
      </p>
    </div>
  );
}

export class AppErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // No telemetry endpoint in a self-hosted panel — the console is where an operator looks.
    console.error('Platter render error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return <CrashScreen error={this.state.error} homeTo={this.props.homeTo ?? '/'} />;
    }
    return this.props.children;
  }
}

/**
 * Router-level failures: a thrown loader response, an unmatched nested route, or a render
 * error inside a route element. Rendered inside the shell so the sidebar survives.
 */
export function RouteErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    const isNotFound = error.status === 404;
    return (
      <div className="flex flex-col items-center justify-center gap-4 px-6 py-24 text-center">
        <h1 className="text-title-1 text-label">
          {isNotFound ? 'No page here' : `Request failed (${error.status})`}
        </h1>
        <p className="max-w-prose text-balance text-body text-label-secondary">
          {isNotFound
            ? 'The address is wrong, or whatever used to be here has been deleted.'
            : error.statusText || 'The router could not load this route.'}
        </p>
        <Button asChild className={pageActionClass} size="lg">
          <Link to="/">Go to the dashboard</Link>
        </Button>
      </div>
    );
  }

  if (error instanceof Error) {
    return <CrashScreen error={error} />;
  }

  return <ErrorState error={error} onRetry={() => window.location.reload()} />;
}
