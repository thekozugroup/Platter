import { Banner } from '@astryxdesign/core/Banner';
import { Card } from '@astryxdesign/core/Card';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { LayoutContent } from '@astryxdesign/core/Layout';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { describeServer, listEvents, readStats, selectImage } from '@platter/core';
import { heapForContainer, LOADER_LABELS } from '@platter/shared';
import { notFound } from 'next/navigation';
import { ActivityList } from '@/components/activity-list';
import { CopyableValue } from '@/components/copyable-value';
import { DockerUnavailable } from '@/components/docker-unavailable';
import { lanAddresses } from '@/lib/network';
import { tryGetContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

/**
 * The overview.
 *
 * Answers, in order: how do my friends join, is anything wrong, and what is this server made of.
 * The address comes first because it is the single most-used thing on the page — people open
 * Platter to copy an address far more often than to change a setting.
 */
export default async function ServerOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await tryGetContext();
  if (!result.ok) {
    return <DockerUnavailable message={result.error.message} />;
  }

  const described = await describeServer(result.context, id);
  if (!described.ok) {
    notFound();
  }

  const { server, health, exitCode } = described.value;
  const image = selectImage(
    server.loader,
    server.gameVersion,
    result.context.env.PLATTER_MINECRAFT_IMAGE_REPO
  );
  const heapMiB = heapForContainer(server.memoryMiB);

  // Best-first; the rest are offered as alternatives rather than hidden, because only the person
  // at the keyboard knows which network their friends are actually on.
  const [lan, ...others] = lanAddresses();

  const stats =
    server.containerId && server.status === 'running'
      ? await readStats(result.context.docker, server.containerId)
      : undefined;

  const events = listEvents(result.context.db, { serverId: id, limit: 8 });

  return (
    <LayoutContent padding={5}>
      <VStack gap={5} maxWidth={860}>
        {server.status === 'crashed' && server.statusMessage ? (
          <Banner
            status="error"
            title="This server crashed"
            description={server.statusMessage}
            endContent={
              <Text type="supporting">
                Open the Console tab to see the last output before it stopped.
              </Text>
            }
          />
        ) : null}

        {server.status === 'unhealthy' ? (
          <Banner
            status="warning"
            title="Not responding"
            description={
              server.statusMessage ??
              'The container is running but failing its health check. It may be hung or short on memory.'
            }
          />
        ) : null}

        <Card padding={4}>
          <VStack gap={3}>
            <Heading level={2}>Connect</Heading>
            {/*
             * The shareable address comes first, and `localhost` is labelled as what it is.
             *
             * These were the wrong way round: the page showed `localhost:25565` directly under
             * "Give this address to anyone on your network", so everyone who was handed it
             * connected to their own machine. Platter publishes game ports on every interface,
             * so the LAN address works — it was simply never displayed.
             */}
            <Text type="supporting">
              {lan
                ? `Give the first address to anyone on your network. Platter picked it from ${lan.iface}; if your friends are on a different network, use the address for that one.`
                : 'Platter could not find a network address for this machine. Anyone on your network can still connect using its IP address and the port below.'}
            </Text>
            <Grid columns={{ minWidth: 260, max: 2 }} gap={3}>
              {lan ? (
                <CopyableValue label="Server address" value={`${lan.address}:${server.port}`} />
              ) : null}
              <CopyableValue label="From this machine" value={`localhost:${server.port}`} />
              <CopyableValue label="Port" value={String(server.port)} />
            </Grid>
            {others.length > 0 ? (
              <Text type="supporting">
                Other addresses for this machine:{' '}
                {others.map((entry) => `${entry.address} (${entry.iface})`).join(', ')}
              </Text>
            ) : null}
          </VStack>
        </Card>

        <Grid columns={{ minWidth: 300, max: 2 }} gap={3}>
          <Card padding={4}>
            <VStack gap={3}>
              <Heading level={2}>Runtime</Heading>
              <MetadataList columns="single">
                <MetadataListItem label="Edition">
                  {LOADER_LABELS[server.loader]} {server.gameVersion}
                </MetadataListItem>
                <MetadataListItem label="Java">Java {image.javaVersion}</MetadataListItem>
                <MetadataListItem label="Image">
                  <Text type="code">{server.image}</Text>
                </MetadataListItem>
                <MetadataListItem label="Memory">
                  {formatMiB(server.memoryMiB)} container · {formatMiB(heapMiB)} heap
                </MetadataListItem>
                <MetadataListItem label="CPU">{server.cpus} cores</MetadataListItem>
                {health && health !== 'none' ? (
                  <MetadataListItem label="Health">{health}</MetadataListItem>
                ) : null}
                {/* Only worth showing when it explains something — a clean 0 is noise. */}
                {exitCode !== undefined && exitCode !== 0 && server.status !== 'running' ? (
                  <MetadataListItem label="Last exit code">
                    {exitCode === 137 ? '137 — killed, usually out of memory' : String(exitCode)}
                  </MetadataListItem>
                ) : null}
              </MetadataList>
              <Text type="supporting">{image.reason}</Text>
            </VStack>
          </Card>

          <Card padding={4}>
            <VStack gap={3}>
              <Heading level={2}>Right now</Heading>
              {stats?.ok ? (
                <MetadataList columns="single">
                  <MetadataListItem label="CPU">
                    {stats.value.cpuPercent.toFixed(1)}%
                  </MetadataListItem>
                  <MetadataListItem label="Memory">
                    {formatBytes(stats.value.memoryUsedBytes)} of{' '}
                    {formatBytes(stats.value.memoryLimitBytes)} ({stats.value.memoryPercent}%)
                  </MetadataListItem>
                  <MetadataListItem label="Threads">{String(stats.value.pids)}</MetadataListItem>
                  <MetadataListItem label="Network">
                    ↓ {formatBytes(stats.value.networkRxBytes)} · ↑{' '}
                    {formatBytes(stats.value.networkTxBytes)}
                  </MetadataListItem>
                </MetadataList>
              ) : (
                <Text type="supporting">
                  {server.status === 'running'
                    ? 'Collecting statistics…'
                    : 'Statistics appear once the server is running.'}
                </Text>
              )}
            </VStack>
          </Card>
        </Grid>

        <VStack gap={3}>
          <HStack justify="between" align="center">
            <Heading level={2}>Recent activity</Heading>
          </HStack>
          <ActivityList events={events} emptyMessage="Nothing has happened yet." />
        </VStack>
      </VStack>
    </LayoutContent>
  );
}

function formatMiB(mib: number): string {
  return mib >= 1024 ? `${(mib / 1024).toFixed(mib % 1024 === 0 ? 0 : 1)} GB` : `${mib} MB`;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}
