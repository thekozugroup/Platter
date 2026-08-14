import { Suspense, lazy, type ComponentType } from 'react';
import {
  Navigate,
  Outlet,
  ScrollRestoration,
  createBrowserRouter,
  useLocation,
  type RouteObject,
} from 'react-router';
import type { UserRole } from '@platter/shared';
import { EmptyState } from '@/components/common/empty-state';
import { AppShell, AppSplash } from '@/components/layout/app-shell';
import { RouteErrorBoundary } from '@/components/layout/error-boundary';
import { PageBody, PageHeader } from '@/components/layout/page-header';
import { useAuth } from '@/lib/auth.js';

/**
 * The route table.
 *
 * Screens are loaded through `import.meta.glob` rather than a literal `import()` per route.
 * Six people are building these screens in parallel; a literal import of a file that has not
 * landed yet is a hard build error, and the shell would be unusable until the last of them
 * finished. The glob resolves at build time from whatever exists, and a route whose module
 * is not there yet says so plainly instead of taking the app down.
 *
 * Each page module should export either a default component or a named export matching the
 * file's basename — both are accepted.
 */
const pageModules = import.meta.glob('./pages/**/*.tsx');

function MissingScreen({ modulePath }: { modulePath: string }) {
  return (
    <>
      <PageHeader title="Not built yet" />
      <PageBody>
        <EmptyState
          description={
            <>
              This route is wired up, but <code className="font-mono">{modulePath}</code> does not
              exist yet. It appears as soon as the file lands.
            </>
          }
          size="sm"
          title="This screen has not shipped"
        />
      </PageBody>
    </>
  );
}

/**
 * `path` is relative to `src/pages` and carries no extension, e.g. `server/ConsolePage`.
 * `exportName` is tried before `default`.
 */
function lazyPage(path: string, exportName: string) {
  const modulePath = `./pages/${path}.tsx`;

  const missing: ComponentType = () => <MissingScreen modulePath={`src/pages/${path}.tsx`} />;

  return lazy<ComponentType>(async (): Promise<{ default: ComponentType }> => {
    const loader = pageModules[modulePath];
    if (!loader) return { default: missing };

    const module = (await loader()) as Record<string, unknown>;
    const candidate = module[exportName] ?? module.default;
    if (typeof candidate !== 'function') return { default: missing };

    return { default: candidate as ComponentType };
  });
}

// -- Screens owned by other agents ------------------------------------------------------
const DashboardPage = lazyPage('DashboardPage', 'DashboardPage');
const ServersPage = lazyPage('ServersPage', 'ServersPage');
const CreateServerPage = lazyPage('CreateServerPage', 'CreateServerPage');
const ServerLayout = lazyPage('server/ServerLayout', 'ServerLayout');
const ConsolePage = lazyPage('server/ConsolePage', 'ConsolePage');
const FilesPage = lazyPage('server/FilesPage', 'FilesPage');
const BackupsPage = lazyPage('server/BackupsPage', 'BackupsPage');
const SchedulesPage = lazyPage('server/SchedulesPage', 'SchedulesPage');
const PlayersPage = lazyPage('server/PlayersPage', 'PlayersPage');
const ModsPage = lazyPage('server/ModsPage', 'ModsPage');
const MonitoringPage = lazyPage('server/MonitoringPage', 'MonitoringPage');
const NetworkPage = lazyPage('server/NetworkPage', 'NetworkPage');
const ServerSettingsPage = lazyPage('server/SettingsPage', 'SettingsPage');
const AdminUsersPage = lazyPage('admin/UsersPage', 'UsersPage');
const AdminNodesPage = lazyPage('admin/NodesPage', 'NodesPage');
const AdminAuditPage = lazyPage('admin/AuditPage', 'AuditPage');
const AdminSettingsPage = lazyPage('admin/SettingsPage', 'SettingsPage');

// -- Screens owned by the shell ---------------------------------------------------------
const LoginPage = lazyPage('LoginPage', 'LoginPage');
const SetupPage = lazyPage('SetupPage', 'SetupPage');
const NotFoundPage = lazyPage('NotFoundPage', 'NotFoundPage');
const ProfilePage = lazyPage('account/ProfilePage', 'ProfilePage');

function RootLayout() {
  return (
    <>
      <ScrollRestoration />
      {/*
        Outer boundary, for the signed-out screens. Everything inside the shell has its own
        nested boundary so a navigation never blanks the chrome.
      */}
      <Suspense fallback={<AppSplash />}>
        <Outlet />
      </Suspense>
    </>
  );
}

/**
 * The authenticated frame.
 *
 * While the silent refresh is in flight this renders a splash, never a redirect. Redirecting
 * would drop the deep link the person opened and flash the login screen on every reload.
 */
function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <AppSplash label="Restoring your session" />;

  if (status === 'anonymous') {
    const next = `${location.pathname}${location.search}`;
    const to = next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`;
    return <Navigate replace to={to} />;
  }

  return <AppShell />;
}

const ROLE_EXPLANATION: Record<UserRole, string> = {
  owner: 'the owner of this installation',
  admin: 'an administrator',
  member: 'a member',
};

/**
 * Role gate. A redirect here would be a lie — the page exists, the account simply is not
 * allowed to see it — and redirecting an admin page to the dashboard is how you get a loop
 * that nobody can debug from the outside.
 */
function RequireRole({ minimum }: { minimum: UserRole }) {
  const { hasRole, user } = useAuth();

  if (hasRole(minimum)) return <Outlet />;

  return (
    <>
      <PageHeader title="Not your area" />
      <PageBody>
        <EmptyState
          action={{ label: 'Back to the dashboard', to: '/' }}
          description={
            <>
              Administration is limited to {ROLE_EXPLANATION[minimum]}. You are signed in as{' '}
              <strong className="font-medium text-label">{user?.displayName}</strong>,{' '}
              {ROLE_EXPLANATION[user?.role ?? 'member']}. Ask an administrator to change your role
              if you need this.
            </>
          }
          title="You don’t have access to this"
        />
      </PageBody>
    </>
  );
}

/** Keeps a signed-in person out of the login screen without a flash of the form. */
function AnonymousOnly({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <AppSplash label="Restoring your session" />;
  if (status === 'authenticated') {
    const next = new URLSearchParams(location.search).get('next');
    return <Navigate replace to={next && next.startsWith('/') ? next : '/'} />;
  }

  return <>{children}</>;
}

export const routes: RouteObject[] = [
  {
    element: <RootLayout />,
    errorElement: <RouteErrorBoundary />,
    children: [
      {
        path: '/login',
        element: (
          <AnonymousOnly>
            <LoginPage />
          </AnonymousOnly>
        ),
      },
      { path: '/setup', element: <SetupPage /> },
      {
        element: <RequireAuth />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'servers', element: <ServersPage /> },
          { path: 'servers/new', element: <CreateServerPage /> },
          {
            path: 'servers/:serverId',
            element: <ServerLayout />,
            children: [
              { index: true, element: <ConsolePage /> },
              { path: 'files', element: <FilesPage /> },
              { path: 'backups', element: <BackupsPage /> },
              { path: 'schedules', element: <SchedulesPage /> },
              { path: 'players', element: <PlayersPage /> },
              { path: 'mods', element: <ModsPage /> },
              { path: 'monitoring', element: <MonitoringPage /> },
              { path: 'network', element: <NetworkPage /> },
              { path: 'settings', element: <ServerSettingsPage /> },
            ],
          },
          { path: 'account', element: <ProfilePage /> },
          {
            path: 'admin',
            element: <RequireRole minimum="admin" />,
            children: [
              { index: true, element: <Navigate replace to="/admin/users" /> },
              { path: 'users', element: <AdminUsersPage /> },
              { path: 'nodes', element: <AdminNodesPage /> },
              { path: 'audit', element: <AdminAuditPage /> },
              { path: 'settings', element: <AdminSettingsPage /> },
            ],
          },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];

export function createRouter() {
  return createBrowserRouter(routes);
}
