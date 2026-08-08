import { useLocation, useNavigate } from 'react-router';
import { Home } from 'pixelarticons/react/Home.js';
import { Plus } from 'pixelarticons/react/Plus.js';
import { Server } from 'pixelarticons/react/Server.js';
import { User } from 'pixelarticons/react/User.js';
import {
  BottomNavigation,
  BottomNavigationItem,
  BottomNavigationItemIcon,
  BottomNavigationItemLabel,
  BottomNavigationList,
} from '@/components/ui/bottom-navigation';
import type { NavItem } from '@/components/layout/sidebar';

/**
 * The phone navigation bar — the one glass surface in the product.
 *
 * DESIGN §4 names this specifically: "a fully-round floating pill — white at 80% over
 * `backdrop-filter: blur(8px)` with a 1px `rgba(0,0,0,0.06)` edge", lifted on
 * `--pl-shadow-nav`. Shark's `BottomNavigationList` ships a square, opaque bar welded to
 * three screen edges, so the pill is composed here rather than by editing the registry
 * component: DESIGN §1 keeps `components/ui/` generic and puts screen composition in
 * `components/<feature>/`.
 *
 * `.frost` (global.css) is the material — tint, hairline and blur in one class, already
 * wired to `prefers-reduced-transparency` and to a solid fallback where `backdrop-filter`
 * is unsupported. `w-auto` is what lets the inset-x-0 list take margins instead of spanning
 * the viewport; `border-t-0` drops the registry's top rule, which a floating pill must not
 * carry.
 *
 * Four destinations, thumb-reachable, each a full-height 56px target that clears the 44px
 * minimum on its own. It sits below 768px only; above that the sidebar is always visible
 * and a second navigation would just be a second place to look.
 *
 * The bar's own box stays in the flow while its list is fixed, so it reserves exactly the
 * space it covers and the last row of a list is never trapped under it — now
 * `--pl-nav-clearance`, the token that exists for this, because the pill also has to clear
 * its own bottom margin and the home-indicator inset.
 */
const MOBILE_NAV: readonly NavItem[] = [
  { to: '/', label: 'Home', icon: Home, match: (p) => p === '/' },
  {
    to: '/servers',
    label: 'Servers',
    icon: Server,
    match: (p) => p === '/servers' || (p.startsWith('/servers/') && p !== '/servers/new'),
  },
  { to: '/servers/new', label: 'New', icon: Plus, match: (p) => p === '/servers/new' },
  { to: '/account', label: 'Account', icon: User, match: (p) => p.startsWith('/account') },
];

export function MobileNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const active = MOBILE_NAV.find((item) => item.match(pathname))?.to ?? '';

  return (
    /*
     * Shark's `BottomNavigation` renders divs, so the `<nav>` is added here — otherwise the
     * phone layout has no navigation landmark either. The label distinguishes it from the
     * sidebar's "Main" for anyone listing landmarks, even though only one is ever visible.
     */
    <nav aria-label="Primary" className="md:hidden">
      <BottomNavigation
        className="min-h-[calc(var(--pl-nav-clearance)+env(safe-area-inset-bottom,0px))]"
        onValueChange={({ value }) => void navigate(value)}
        value={active}
      >
        <BottomNavigationList className="mx-4 mb-[calc(var(--pl-space-md)+env(safe-area-inset-bottom,0px))] w-auto rounded-full border border-frost-border bg-frost px-2 pb-0 shadow-nav backdrop-blur-nav backdrop-saturate-[var(--pl-frost-saturate)]">
          {MOBILE_NAV.map((item) => {
            const Icon = item.icon;
            return (
              <BottomNavigationItem
                className="min-h-14 gap-1 aria-selected:font-semibold aria-selected:text-label"
                key={item.to}
                value={item.to}
              >
                <BottomNavigationItemIcon>
                  <Icon aria-hidden />
                </BottomNavigationItemIcon>
                <BottomNavigationItemLabel>{item.label}</BottomNavigationItemLabel>
              </BottomNavigationItem>
            );
          })}
        </BottomNavigationList>
      </BottomNavigation>
    </nav>
  );
}
