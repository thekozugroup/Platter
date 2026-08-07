import { Banner } from '@astryxdesign/core/Banner';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { checkDocker, listServers } from '@platter/core';
import type { Metadata } from 'next';
import { CopyableValue } from '@/components/copyable-value';
import { tryGetContext } from '@/lib/server';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

/**
 * Platter's own settings.
 *
 * Read-only on purpose. Everything here comes from the environment, and a UI that let you edit
 * it would either have to write a file Platter does not own or hold a second, divergent copy of
 * the configuration. Showing the effective values — and where to change them — is more honest
 * and much harder to get wrong.
 */
export default async function SettingsPage() {
  const result = await tryGetContext();

  if (!result.ok) {
    return (
      <Layout height="fill">
        <LayoutContent padding={5}>
          <Banner
            status="error"
            title="Platter can't reach Docker"
            description={result.error.message}
          />
        </LayoutContent>
      </Layout>
    );
  }

  const { env, db, docker } = result.context;
  const health = await checkDocker(docker, env.PLATTER_DOCKER_SOCKET);
  const servers = listServers(db);
  const usedPorts = servers.length;
  const totalPorts = env.PLATTER_PORT_RANGE_END - env.PLATTER_PORT_RANGE_START + 1;

  return (
    <Layout height="fill">
      <LayoutHeader hasDivider>
        <VStack padding={5} gap={0.5}>
          <Heading level={1}>Settings</Heading>
          <Text type="supporting">
            Platter is configured through environment variables. These are the values it is running
            with.
          </Text>
        </VStack>
      </LayoutHeader>

      <LayoutContent padding={5}>
        <VStack gap={4} maxWidth={720}>
          <Card padding={4}>
            <VStack gap={3}>
              <Heading level={2}>Docker</Heading>
              {health.ok ? (
                <MetadataList columns="single">
                  <MetadataListItem label="Engine">
                    {health.value.version} ({health.value.os}/{health.value.arch})
                  </MetadataListItem>
                  <MetadataListItem label="Host resources">
                    {health.value.cpus} CPUs, {formatBytes(health.value.memTotal)} RAM
                  </MetadataListItem>
                  <MetadataListItem label="Storage driver">
                    {health.value.storageDriver}
                  </MetadataListItem>
                  <MetadataListItem label="Socket">
                    <Text type="code">{env.PLATTER_DOCKER_SOCKET}</Text>
                  </MetadataListItem>
                  <MetadataListItem label="Network">
                    <Text type="code">{env.PLATTER_DOCKER_NETWORK}</Text>
                  </MetadataListItem>
                </MetadataList>
              ) : (
                <Banner status="error" title="Unreachable" description={health.error.message} />
              )}
            </VStack>
          </Card>

          <Card padding={4}>
            <VStack gap={3}>
              <Heading level={2}>Storage</Heading>
              <CopyableValue label="Data directory" value={env.PLATTER_DATA_DIR} />
              <Text type="supporting">
                The database, every world, every backup and the mod cache all live here. This is the
                one directory to back up, and the one to delete to start over.
              </Text>
            </VStack>
          </Card>

          <Card padding={4}>
            <VStack gap={3}>
              <Heading level={2}>Networking</Heading>
              <MetadataList columns="single">
                <MetadataListItem label="Platter listens on">
                  <Text type="code">
                    {env.PLATTER_HOST}:{env.PLATTER_PORT}
                  </Text>
                </MetadataListItem>
                <MetadataListItem label="Game server ports">
                  <Text type="code">
                    {env.PLATTER_PORT_RANGE_START}–{env.PLATTER_PORT_RANGE_END}
                  </Text>{' '}
                  ({usedPorts} of {totalPorts} in use)
                </MetadataListItem>
                <MetadataListItem label="Published on">
                  <Text type="code">{env.PLATTER_BIND_ADDRESS}</Text>
                </MetadataListItem>
              </MetadataList>
              {env.PLATTER_HOST === '127.0.0.1' ? (
                <Text type="supporting">
                  Platter is only reachable from this machine. Game servers are published on{' '}
                  {env.PLATTER_BIND_ADDRESS === '0.0.0.0'
                    ? 'every interface'
                    : env.PLATTER_BIND_ADDRESS}
                  , so other people can still join them.
                </Text>
              ) : (
                <Banner
                  status="warning"
                  title="Platter is reachable from the network"
                  description="Anyone who can reach it and has the token has full control of this machine's containers. See SECURITY.md."
                />
              )}
            </VStack>
          </Card>

          <Card padding={4}>
            <VStack gap={3}>
              <Heading level={2}>Mod providers</Heading>
              <MetadataList columns="single">
                <MetadataListItem label="Modrinth">
                  {env.MODRINTH_TOKEN ? 'Authenticated' : 'Anonymous (works, lower rate limit)'}
                </MetadataListItem>
                <MetadataListItem label="CurseForge">
                  {env.CURSEFORGE_API_KEY ? 'Enabled' : 'Disabled — no API key set'}
                </MetadataListItem>
              </MetadataList>
              {env.CURSEFORGE_API_KEY ? null : (
                <Text type="supporting">
                  CurseForge needs an API key, which requires approval from Overwolf. Without one
                  Platter searches Modrinth only, rather than failing halfway through a search.
                </Text>
              )}
            </VStack>
          </Card>

          <Card padding={4}>
            <VStack gap={3}>
              <Heading level={2}>AI access</Heading>
              <Text type="supporting">
                Platter's MCP server lets an assistant manage these servers. Reading is free;
                anything that changes a server asks you to confirm first.
              </Text>
              <CopyableValue
                label="Add to Claude Code"
                value="claude mcp add platter -- npx -y @platter/mcp"
              />
              <MetadataList columns="single">
                <MetadataListItem label="HTTP transport">
                  <Text type="code">
                    {env.PLATTER_MCP_HOST}:{env.PLATTER_MCP_PORT}
                  </Text>
                </MetadataListItem>
              </MetadataList>
            </VStack>
          </Card>
        </VStack>
      </LayoutContent>
    </Layout>
  );
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
