import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { listServers } from '@platter/core';
import type { Metadata } from 'next';
import { DockerUnavailable } from '@/components/docker-unavailable';
import { ServerCard } from '@/components/server-card';
import { lanAddresses } from '@/lib/network';
import { tryGetContext } from '@/lib/server';

export const metadata: Metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const result = await tryGetContext();

  if (!result.ok) {
    return <DockerUnavailable message={result.error.message} />;
  }

  const servers = listServers(result.context.db);
  // Resolved once for the whole grid: it is the same answer for every card, and it is the
  // address someone can actually hand to a friend.
  const host = lanAddresses()[0]?.address ?? 'localhost';

  return (
    <Layout height="fill">
      <LayoutHeader hasDivider>
        <HStack padding={5} justify="between" align="center" wrap="wrap" gap={3}>
          <VStack gap={0.5}>
            <Heading level={1}>Servers</Heading>
            <Text type="supporting">
              {servers.length === 0
                ? 'Nothing running yet.'
                : `${servers.length} server${servers.length === 1 ? '' : 's'} · ${
                    servers.filter((server) => server.status === 'running').length
                  } running`}
            </Text>
          </VStack>
          <Button label="New server" variant="primary" href="/new" />
        </HStack>
      </LayoutHeader>

      <LayoutContent padding={5}>
        {servers.length === 0 ? (
          <EmptyState
            title="No servers yet"
            description="Create your first Minecraft server. Platter picks the right Java version, sizes the heap, and hands you an address to share."
            actions={<Button label="Create a server" variant="primary" href="/new" />}
          />
        ) : (
          // Two columns at most, so a card stays wide enough to show an address and a status
          // without truncating either.
          <Grid columns={{ minWidth: 380, max: 2 }} gap={3}>
            {servers.map((server) => (
              <ServerCard
                key={server.id}
                id={server.id}
                name={server.name}
                status={server.status}
                loader={server.loader}
                gameVersion={server.gameVersion}
                port={server.port}
                memoryMiB={server.memoryMiB}
                host={host}
                statusMessage={server.statusMessage}
              />
            ))}
          </Grid>
        )}
      </LayoutContent>
    </Layout>
  );
}
