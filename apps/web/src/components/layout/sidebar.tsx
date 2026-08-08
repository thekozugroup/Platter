import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type React from 'react';
import { Link, useLocation } from 'react-router';
import type { Paginated, ServerSummary } from '@platter/shared';
import { Article } from 'pixelarticons/react/Article.js';
import { ChevronLeft } from 'pixelarticons/react/ChevronLeft.js';
import { ChevronRight } from 'pixelarticons/react/ChevronRight.js';
import { Cpu } from 'pixelarticons/react/Cpu.js';
import { Home } from 'pixelarticons/react/Home.js';
import { Lightbulb } from 'pixelarticons/react/Lightbulb.js';
import { Logout } from 'pixelarticons/react/Logout.js';
import { Monitor } from 'pixelarticons/react/Monitor.js';
import { Moon } from 'pixelarticons/react/Moon.js';
import { Plus } from 'pixelarticons/react/Plus.js';
import { Search } from 'pixelarticons/react/Search.js';
import { Server } from 'pixelarticons/react/Server.js';
import { SettingsCog } from 'pixelarticons/react/SettingsCog.js';
import { User } from 'pixelarticons/react/User.js';
import { Users } from 'pixelarticons/react/Users.js';
import { GameIcon } from '@/components/common/game-icon';
import { StatusDot } from '@/components/common/status-pill';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '@/components/ui/menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from '@/components/ui/sidebar';
import { api } from '@/lib/api-client.js';
import { useAuth } from '@/lib/auth.js';
import { queryKeys } from '@/lib/query.js';
import { useTheme, type ThemePreference } from '@/lib/theme.js';
import { cn } from '@/lib/utils';

/**
 * The navigation sidebar.
 *
 * Warm off-white, a hairline instead of a border, and no colour anywhere except the game
 * marks and the status dots. Rows are 44px tall so they are real touch targets even in the
 * collapsed rail, which is the size most sidebars get wrong.
 */

type IconComponent = (props: React.SVGProps<SVGSVGElement>) => React.JSX.Element;

export interface NavItem {
  to: string;
  label: string;
  icon: IconComponent;
  /** Explicit, because `/servers/new` must not also light up `/servers`. */
  match: (pathname: string) => boolean;
}

export const PRIMARY_NAV: readonly NavItem[] = [
  { to: '/', label: 'Dashboard', icon: Home, match: (p) => p === '/' },
  {
    to: '/servers',
    label: 'Servers',
    icon: Server,
    match: (p) => p === '/servers' || (p.startsWith('/servers/') && p !== '/servers/new'),
  },
  { to: '/servers/new', label: 'New server', icon: Plus, match: (p) => p === '/servers/new' },
];

export const ADMIN_NAV: readonly NavItem[] = [
  { to: '/admin/users', label: 'Users', icon: Users, match: (p) => p.startsWith('/admin/users') },
  { to: '/admin/nodes', label: 'Nodes', icon: Cpu, match: (p) => p.startsWith('/admin/nodes') },
  {
    to: '/admin/audit',
    label: 'Audit log',
    icon: Article,
    match: (p) => p.startsWith('/admin/audit'),
  },
  {
    to: '/admin/settings',
    label: 'Settings',
    icon: SettingsCog,
    match: (p) => p.startsWith('/admin/settings'),
  },
];

/**
 * One poll for every status dot in the chrome, rather than a socket per server. Ten servers
 * would otherwise mean ten websockets open purely to tint a 8px circle.
 */
const NAV_SERVERS_QUERY = { perPage: 50, sort: 'name', order: 'asc' } as const;

export function useSidebarServers(): UseQueryResult<Paginated<ServerSummary>> {
  const { status } = useAuth();

  return useQuery({
    queryKey: queryKeys.servers.list(NAV_SERVERS_QUERY),
    queryFn: () => api.get<Paginated<ServerSummary>>('/servers', { query: NAV_SERVERS_QUERY }),
    enabled: status === 'authenticated',
    // Paused automatically while the tab is in the background.
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

/** Shared row geometry: 44px tall, 12px radius, quiet until hovered or selected. */
const NAV_ROW = cn(
  'h-11 w-full justify-start gap-3 rounded-md px-3',
  'text-subhead font-normal text-sidebar-foreground',
  'hover:bg-fill-tertiary hover:text-label',
  'data-[active=true]:bg-sidebar-accent data-[active=true]:text-label data-[active=true]:font-medium',
  'group-data-[collapsible=icon]:size-11! group-data-[collapsible=icon]:justify-center',
  'group-data-[collapsible=icon]:px-0!',
);

const COLLAPSED_LABEL = 'group-data-[collapsible=icon]:hidden';

function CollapseControl() {
  const { state, toggleSidebar, isMobile } = useSidebar();
  const collapsed = state === 'collapsed';

  // On a phone the sidebar is a sheet with its own close affordance; a collapse toggle there
  // would do nothing visible.
  if (isMobile) return null;

  return (
    <Button
      aria-expanded={!collapsed}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      className="hit-target size-8 shrink-0 text-label-tertiary hover:bg-fill-tertiary hover:text-label"
      onClick={toggleSidebar}
      size="icon-md"
      variant="ghost"
    >
      {collapsed ? <ChevronRight aria-hidden /> : <ChevronLeft aria-hidden />}
    </Button>
  );
}

function NavRow({ item }: { item: NavItem }) {
  const { pathname } = useLocation();
  const { isMobile, setOpenMobile } = useSidebar();
  const Icon = item.icon;
  const active = item.match(pathname);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild className={NAV_ROW} isActive={active} tooltip={item.label}>
        <Link
          onClick={() => {
            // Navigating inside the sheet has to close it, or the destination is hidden.
            if (isMobile) setOpenMobile(false);
          }}
          to={item.to}
        >
          <Icon aria-hidden />
          <span className={COLLAPSED_LABEL}>{item.label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function ServerRows() {
  const { pathname } = useLocation();
  const { isMobile, setOpenMobile } = useSidebar();
  const { data, isPending, isError, refetch } = useSidebarServers();

  if (isPending) {
    return (
      <>
        <SidebarMenuSkeleton className="h-11" showIcon />
        <SidebarMenuSkeleton className="h-11" showIcon />
        <SidebarMenuSkeleton className="h-11" showIcon />
      </>
    );
  }

  if (isError) {
    return (
      <div className={cn('px-3 py-2', COLLAPSED_LABEL)}>
        <p className="text-caption text-label-tertiary">Couldn’t load your servers.</p>
        <Button
          className="mt-1 h-8 px-0 text-caption text-label underline-offset-4 hover:underline"
          onClick={() => void refetch()}
          size="sm"
          variant="link"
        >
          Retry
        </Button>
      </div>
    );
  }

  if (data.data.length === 0) {
    return (
      <p className={cn('px-3 py-2 text-caption text-label-tertiary', COLLAPSED_LABEL)}>
        No servers yet. Create one to see it here.
      </p>
    );
  }

  return (
    <>
      {data.data.map((server) => (
        <SidebarMenuItem key={server.id}>
          <SidebarMenuButton
            asChild
            className={NAV_ROW}
            isActive={pathname.startsWith(`/servers/${server.id}`)}
            tooltip={server.name}
          >
            <Link
              onClick={() => {
                if (isMobile) setOpenMobile(false);
              }}
              to={`/servers/${server.id}`}
            >
              <GameIcon blueprintKey={server.blueprintKey} name={server.name} size="xs" />
              <span className={cn('min-w-0 flex-1 truncate text-start', COLLAPSED_LABEL)}>
                {server.name}
              </span>
              <StatusDot className={cn('ms-auto', COLLAPSED_LABEL)} status={server.status} />
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </>
  );
}

const THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  icon: IconComponent;
}> = [
  { value: 'light', label: 'Light', icon: Lightbulb },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'Match system', icon: Monitor },
];

function AccountMenu() {
  const { user, logout } = useAuth();
  const { preference, setPreference } = useTheme();

  if (!user) return null;

  return (
    <Menu
      onSelect={({ value }) => {
        if (value === 'sign-out') void logout();
      }}
      positioning={{ placement: 'top-start' }}
    >
      <MenuTrigger asChild>
        <Button
          aria-label={`Account: ${user.displayName}`}
          className={cn(
            'h-14 w-full justify-start gap-3 rounded-md px-2 text-start',
            'hover:bg-fill-tertiary',
            'group-data-[collapsible=icon]:size-11! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0!',
          )}
          variant="ghost"
        >
          <Avatar className="size-8 rounded-sm" size="md">
            <AvatarFallback
              className="rounded-sm text-caption font-semibold text-white"
              style={{ backgroundColor: user.avatarColor }}
            >
              {user.displayName.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>

          <span className={cn('flex min-w-0 flex-1 flex-col', COLLAPSED_LABEL)}>
            <span className="truncate text-subhead font-medium text-label">
              {user.displayName}
            </span>
            <span className="truncate text-caption font-normal text-label-tertiary">
              {user.email}
            </span>
          </span>

          <ChevronRight
            aria-hidden
            className={cn('size-4 shrink-0 text-label-quaternary', COLLAPSED_LABEL)}
          />
        </Button>
      </MenuTrigger>

      <MenuContent className="w-56">
        <MenuItem asChild value="account">
          <Link to="/account">
            <User aria-hidden />
            Profile and security
          </Link>
        </MenuItem>

        <MenuSeparator />

        <MenuRadioGroup
          heading="Theme"
          onValueChange={({ value }) => setPreference(value as ThemePreference)}
          value={preference}
        >
          {THEME_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <MenuRadioItem key={option.value} value={option.value}>
                <Icon aria-hidden />
                {option.label}
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>

        <MenuSeparator />

        <MenuItem value="sign-out">
          <Logout aria-hidden />
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export interface AppSidebarProps {
  /** Opens the command palette. Passed down rather than pulled from context so this file
   *  stays free of a cycle with `command-palette.tsx`, which reads the nav model from here. */
  onSearch: () => void;
  /** `⌘K` or `Ctrl K`, whichever this keyboard uses. */
  searchShortcut: string;
}

export function AppSidebar({ onSearch, searchShortcut }: AppSidebarProps) {
  const { isAdmin } = useAuth();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-0 px-3 pt-3 pb-1">
        <div className="flex h-11 items-center justify-between gap-2">
          <Link
            className={cn(
              'rounded-xs font-heading text-headline font-medium tracking-title text-label',
              COLLAPSED_LABEL,
            )}
            to="/"
          >
            Platter
          </Link>
          <CollapseControl />
        </div>
      </SidebarHeader>

      <SidebarContent className="gap-5 px-3">
        <SidebarGroup className="p-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              <SidebarMenuItem>
                <SidebarMenuButton
                  className={NAV_ROW}
                  onClick={onSearch}
                  tooltip={`Search — ${searchShortcut}`}
                >
                  <Search aria-hidden />
                  <span className={COLLAPSED_LABEL}>Search</span>
                  <Kbd className={cn('ms-auto bg-transparent', COLLAPSED_LABEL)} variant="outline">
                    {searchShortcut}
                  </Kbd>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {PRIMARY_NAV.map((item) => (
                <NavRow item={item} key={item.to} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="p-0">
          <SidebarGroupLabel className="px-3 text-caption text-label-tertiary">
            Servers
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              <ServerRows />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {isAdmin ? (
          <SidebarGroup className="p-0">
            <SidebarGroupLabel className="px-3 text-caption text-label-tertiary">
              Administration
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">
                {ADMIN_NAV.map((item) => (
                  <NavRow item={item} key={item.to} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
      </SidebarContent>

      <SidebarFooter className="border-t border-separator p-3">
        <AccountMenu />
      </SidebarFooter>
    </Sidebar>
  );
}
