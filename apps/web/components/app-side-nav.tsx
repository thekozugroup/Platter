'use client';

import { Button } from '@astryxdesign/core/Button';
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { MinecraftLoader, ServerStatus } from '@platter/shared';
import { usePathname } from 'next/navigation';
import { presentStatus } from '@/lib/status';
import { ThemeToggle } from './theme-toggle';

export interface NavServer {
  id: string;
  name: string;
  status: ServerStatus;
  loader: MinecraftLoader;
  gameVersion: string;
}

/**
 * The persistent navigation.
 *
 * Every server is listed with a status dot, which makes the sidebar the fastest answer to "is
 * everything up" — the question people open this app to ask. The dot carries a tooltip with the
 * explanation, so colour is never the only signal.
 */
export function AppSideNav({ servers }: { servers: NavServer[] }) {
  const pathname = usePathname();

  return (
    <SideNav
      header={<SideNavHeading heading="Platter" headingHref="/" subheading="Game servers" />}
      topContent={
        <VStack padding={2}>
          <Button label="New server" variant="primary" width="100%" href="/new" />
        </VStack>
      }
      footer={<ThemeToggle />}
      collapsible
      resizable={{ defaultWidth: 260, minWidth: 200, maxWidth: 360, autoSaveId: 'platter-nav' }}
    >
      <SideNavSection title="Overview">
        <SideNavItem label="Dashboard" href="/" isSelected={pathname === '/'} />
        <SideNavItem label="Activity" href="/activity" isSelected={pathname === '/activity'} />
        <SideNavItem
          label="Settings"
          href="/settings"
          isSelected={pathname.startsWith('/settings')}
        />
      </SideNavSection>

      <SideNavSection title="Servers">
        {servers.length === 0 ? (
          <VStack paddingInline={3} paddingBlock={2}>
            <Text type="supporting">No servers yet.</Text>
          </VStack>
        ) : (
          servers.map((server) => {
            const presentation = presentStatus(server.status);
            return (
              <SideNavItem
                key={server.id}
                label={server.name}
                href={`/servers/${server.id}`}
                isSelected={pathname.startsWith(`/servers/${server.id}`)}
                endContent={
                  <StatusDot
                    variant={presentation.variant}
                    label={presentation.label}
                    tooltip={presentation.tooltip}
                    isPulsing={presentation.pulsing}
                  />
                }
              />
            );
          })
        )}
      </SideNavSection>
    </SideNav>
  );
}
