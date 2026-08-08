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
 * The phone navigation bar.
 *
 * Four destinations, thumb-reachable, each a full-height 56px target that clears the 44px
 * minimum on its own. It sits below 768px only; above that the sidebar is always visible
 * and a second navigation would just be a second place to look.
 *
 * The bar's own box stays in the flow while its list is fixed, so it reserves exactly the
 * space it covers and the last row of a list is never trapped under it.
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
    <BottomNavigation
      className="md:hidden"
      onValueChange={({ value }) => void navigate(value)}
      value={active}
    >
      <BottomNavigationList aria-label="Primary" className="bg-bg">
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
  );
}
