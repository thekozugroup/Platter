import { Banner } from '@astryxdesign/core/Banner';
import { Heading } from '@astryxdesign/core/Heading';
import { LayoutContent } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { contentDirectory, getServer } from '@platter/core';
import { modInstalls } from '@platter/db';
import { LOADER_FAMILY, LOADER_LABELS } from '@platter/shared';
import { and, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { DockerUnavailable } from '@/components/docker-unavailable';
import { ModsPanel } from '@/components/mods-panel';
import { tryGetContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function ModsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await tryGetContext();
  if (!result.ok) {
    return <DockerUnavailable message={result.error.message} />;
  }

  const server = getServer(result.context.db, id);
  if (!server) {
    notFound();
  }

  const family = LOADER_FAMILY[server.loader];

  if (family === 'vanilla') {
    return (
      <LayoutContent padding={5}>
        <VStack gap={4} maxWidth={640}>
          <Banner
            status="info"
            title="Vanilla servers can't load mods"
            description={
              `${server.name} runs unmodified Minecraft. To add content, create a new server ` +
              'using Paper (for plugins) or Fabric / NeoForge (for mods) — your world can be ' +
              'restored into it from a backup.'
            }
          />
        </VStack>
      </LayoutContent>
    );
  }

  const installed = result.context.db
    .select()
    .from(modInstalls)
    .where(and(eq(modInstalls.serverId, server.id), eq(modInstalls.status, 'installed')))
    .all();

  const noun = family === 'plugin' ? 'plugins' : 'mods';

  return (
    <LayoutContent padding={5}>
      <VStack gap={4} maxWidth={900}>
        <VStack gap={1}>
          <Heading level={2}>{family === 'plugin' ? 'Plugins' : 'Mods'}</Heading>
          <Text type="supporting">
            {LOADER_LABELS[server.loader]} {server.gameVersion}. Platter checks every candidate
            against this server before offering it, resolves an actual downloadable file rather than
            trusting a project's advertised support, and pulls in required dependencies. Files land
            in <Text type="code">/data/{contentDirectory(server.loader)}</Text>.
          </Text>
        </VStack>

        <ModsPanel
          serverId={server.id}
          serverStatus={server.status}
          noun={noun}
          curseforgeEnabled={Boolean(result.context.env.CURSEFORGE_API_KEY)}
          installed={installed.map((row) => ({
            id: row.id,
            name: row.displayName,
            provider: row.provider,
            slug: row.projectSlug,
            version: row.versionLabel,
            isDependency: row.isDependency,
            installedBy: row.installedBy,
            fileSize: row.fileSize,
          }))}
        />
      </VStack>
    </LayoutContent>
  );
}
