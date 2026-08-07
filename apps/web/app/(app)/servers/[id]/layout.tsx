import { Layout, LayoutHeader } from '@astryxdesign/core/Layout';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading } from '@astryxdesign/core/Heading';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { getServer } from '@platter/core';
import { LOADER_LABELS } from '@platter/shared';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ServerControls } from '@/components/server-controls';
import { ServerTabs } from '@/components/server-tabs';
import { presentStatus } from '@/lib/status';
import { tryGetContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await tryGetContext();
  if (!result.ok) {
    return { title: 'Server' };
  }
  const server = getServer(result.context.db, id);
  return { title: server?.name ?? 'Server' };
}

/**
 * The server frame: identity and status at the top, tabs below, page content underneath.
 *
 * The header stays mounted across tab navigation, so the status dot and the start/stop controls
 * never flicker while moving between Console and Backups — which matters because the most
 * common reason to be in here is watching something change.
 */
export default async function ServerLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await tryGetContext();

  if (!result.ok) {
    notFound();
  }

  const server = getServer(result.context.db, id);
  if (!server || server.deletedAt !== null) {
    notFound();
  }

  const presentation = presentStatus(server.status);

  return (
    <Layout height="fill">
        <LayoutHeader hasDivider>
          <VStack paddingInline={5} paddingBlock={4} gap={4}>
            <HStack justify="between" align="center" wrap="wrap" gap={3}>
              <VStack gap={1}>
                <HStack gap={2} align="center">
                  <Heading level={1}>{server.name}</Heading>
                  <StatusDot
                    variant={presentation.variant}
                    label={presentation.label}
                    tooltip={presentation.tooltip}
                    isPulsing={presentation.pulsing}
                  />
                  <Text type="supporting">{presentation.label}</Text>
                </HStack>
                <Text type="supporting">
                  {LOADER_LABELS[server.loader]} {server.gameVersion} ·{' '}
                  <span className="platter-mono">localhost:{server.port}</span>
                </Text>
              </VStack>

              <ServerControls serverId={server.id} status={server.status} name={server.name} />
            </HStack>

            <ServerTabs serverId={server.id} />
          </VStack>
        </LayoutHeader>

      {children}
    </Layout>
  );
}
