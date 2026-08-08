import { Suspense, useCallback, useState } from 'react';
import { Outlet } from 'react-router';
import { AppHeader } from '@/components/layout/header';
import { AppSidebar } from '@/components/layout/sidebar';
import { CommandPaletteProvider, useCommandPalette } from '@/components/layout/command-palette';
import { MobileNav } from '@/components/layout/mobile-nav';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { SkipNavLink } from '@/components/ui/skip-nav';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

/**
 * The application frame: a fixed sidebar, a phone-only top bar, one scrolling content
 * region, and a phone-only bottom navigation. The chrome never moves; only the region
 * between them scrolls.
 *
 * Every screen renders inside `<Outlet/>` and is expected to open with `<PageHeader>` from
 * `layout/page-header.tsx`, which supplies the title, the primary action and the hairline.
 */

const MAIN_ID = 'main-content';
const SIDEBAR_STORAGE_KEY = 'platter.sidebar.expanded';

/** Tablets start collapsed to the icon rail; desktops start expanded. */
function readSidebarExpanded(): boolean {
  try {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
  } catch {
    // Private mode can throw on localStorage. A width-based default is a fine answer.
  }
  if (typeof window === 'undefined') return true;
  /*
   * Collapsing to an icon rail hides every label behind a tooltip, and a tooltip needs a
   * pointer. On a touch tablet at 768–1279px that left nine unlabelled icons with no way to
   * find out what they were, so width alone is the wrong test — hover capability is.
   */
  const hoverable = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? true;
  return !hoverable || window.innerWidth >= 1280;
}

export interface AppSplashProps {
  /** What is being waited on. Announced politely; not drawn until the wait is long enough
   *  to be worth a word. */
  label?: string;
  className?: string;
}

/**
 * Shown while the silent refresh is in flight. Route guards must render this rather than
 * redirecting: bouncing to `/login` on every reload throws away the deep link the person
 * actually opened, and then bounces them back a beat later.
 */
export function AppSplash({ label = 'Loading Platter', className }: AppSplashProps) {
  return (
    <div
      className={cn(
        'flex min-h-svh flex-col items-center justify-center gap-4 bg-bg px-6',
        className,
      )}
    >
      <span className="font-heading text-title-2 font-medium tracking-title text-label">
        Platter
      </span>
      <Spinner aria-hidden className="size-5 text-label-tertiary" />
      <span aria-live="polite" className="sr-only" role="status">
        {label}
      </span>
    </div>
  );
}

/**
 * Placeholder for a screen whose chunk is still downloading. Shaped like a page header and
 * a first card so the layout does not jump when the real thing arrives — a skeleton, not a
 * spinner, because the shape is known.
 */
function PageFallback() {
  return (
    <div aria-busy="true" className="flex flex-1 flex-col">
      <div className="border-b border-separator px-6 pt-10 pb-8 lg:px-12 lg:pt-14">
        <div className="mx-auto w-full max-w-(--pl-container-max)">
          <div className="skeleton h-9 w-56 rounded-sm" />
        </div>
      </div>
      <div className="px-6 py-10 lg:px-12 lg:py-12">
        <div className="mx-auto w-full max-w-(--pl-container-max) space-y-4">
          <div className="skeleton h-28 rounded-md" />
          <div className="skeleton h-28 rounded-md" />
        </div>
      </div>
      <span aria-live="polite" className="sr-only" role="status">
        Loading this screen
      </span>
    </div>
  );
}

function AppShellFrame() {
  const palette = useCommandPalette();
  const [expanded, setExpanded] = useState(readSidebarExpanded);

  const handleOpenChange = useCallback((open: boolean) => {
    setExpanded(open);
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(open));
    } catch {
      // A sidebar that forgets its width is a much smaller problem than a crash here.
    }
  }, []);

  return (
    <SidebarProvider
      onOpenChange={handleOpenChange}
      open={expanded}
      style={{
        '--sidebar-width': 'var(--pl-sidebar-width)',
        '--sidebar-width-icon': 'var(--pl-sidebar-width-collapsed)',
      } as React.CSSProperties}
    >
      {/* First focusable element on the page, by construction. */}
      <SkipNavLink id={MAIN_ID}>Skip to content</SkipNavLink>

      <AppSidebar onSearch={palette.open} searchShortcut={palette.shortcutHint} />

      <SidebarInset asChild>
        <div className="flex min-w-0 flex-1 flex-col bg-bg">
          <AppHeader />

          <main className="flex min-w-0 flex-1 flex-col outline-none" id={MAIN_ID} tabIndex={-1}>
            {/*
              A boundary here rather than at the router root, so loading the next screen's
              chunk swaps the content area and leaves the sidebar and header where they are.
            */}
            <Suspense fallback={<PageFallback />}>
              <Outlet />
            </Suspense>
          </main>

          <MobileNav />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function AppShell() {
  return (
    <CommandPaletteProvider>
      <AppShellFrame />
    </CommandPaletteProvider>
  );
}
