import { Link } from 'react-router';
import { Menu as MenuIcon } from 'pixelarticons/react/Menu.js';
import { Search } from 'pixelarticons/react/Search.js';
import { PlatterMark } from '@/components/common/platter-mark';
import { useCommandPalette } from '@/components/layout/command-palette';
import { Button } from '@/components/ui/button';
import { useSidebar } from '@/components/ui/sidebar';

/**
 * The top chrome.
 *
 * Only on phones. On a wide screen the sidebar carries navigation and each page's own
 * header carries its title and primary action, so a second bar across the top would be a
 * strip of empty white — Ghost's dashboard does not have one and neither does this.
 *
 * Below 768px the sidebar is a sheet, so something has to open it: that is this bar.
 */
export function AppHeader() {
  const { setOpenMobile, openMobile } = useSidebar();
  const palette = useCommandPalette();

  return (
    <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-2 border-b border-separator bg-bg px-4 md:hidden">
      <Button
        aria-expanded={openMobile}
        aria-label="Open navigation"
        className="hit-target size-10 shrink-0 text-label-secondary hover:bg-fill-tertiary hover:text-label"
        onClick={() => setOpenMobile(true)}
        size="icon-xl"
        variant="ghost"
      >
        <MenuIcon aria-hidden />
      </Button>

      <Link
        className="flex items-center gap-2 rounded-xs font-heading text-headline font-medium tracking-title text-label"
        to="/"
      >
        <PlatterMark className="size-5" />
        Platter
      </Link>

      <Button
        aria-label="Search servers and pages"
        className="hit-target ms-auto size-10 shrink-0 text-label-secondary hover:bg-fill-tertiary hover:text-label"
        onClick={palette.open}
        size="icon-xl"
        variant="ghost"
      >
        <Search aria-hidden />
      </Button>
    </header>
  );
}
