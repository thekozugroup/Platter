import { AppShell } from '@astryxdesign/core/AppShell';
import { listServers } from '@platter/core';
import type { ReactNode } from 'react';
import { AppSideNav } from '@/components/app-side-nav';
import { LiveRefresh } from '@/components/live-refresh';
import { tryGetContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

/**
 * The application frame.
 *
 * Responsive contract:
 *   > 1024px  side nav 260 (resizable 200-360) | content
 *   <= 768px  side nav collapses into the MobileNav drawer AppShell provides
 *
 * `contentPadding={0}` because every page owns its own padding — the console and the log views
 * need to run edge to edge, and a shell-level pad would box them in.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const result = await tryGetContext();
  const servers = result.ok ? listServers(result.context.db) : [];

  return (
    <>
      <LiveRefresh />
      <AppShell
        contentPadding={0}
        height="fill"
        variant="elevated"
        sideNav={<AppSideNav servers={servers.map(toNavServer)} />}
      >
        {children}
      </AppShell>
    </>
  );
}

function toNavServer(server: ReturnType<typeof listServers>[number]) {
  return {
    id: server.id,
    name: server.name,
    status: server.status,
    loader: server.loader,
    gameVersion: server.gameVersion,
  };
}
