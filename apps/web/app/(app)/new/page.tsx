import { Heading } from '@astryxdesign/core/Heading';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { availableLoaders, getVersionIndex, LOADER_BLURB } from '@platter/core';
import type { Metadata } from 'next';
import { NewServerForm } from '@/components/new-server-form';
import { tryGetContext } from '@/lib/server';

export const metadata: Metadata = { title: 'New server' };
export const dynamic = 'force-dynamic';

/**
 * The version list is fetched server-side so the form renders with real options on first paint.
 * Only stable releases are offered: snapshots exist, but a snapshot server is a deliberate,
 * advanced choice and putting them in the same list makes it far too easy to pick one by
 * accident and then find no mods work.
 */
export default async function NewServerPage() {
  const result = await tryGetContext();

  if (!result.ok) {
    return (
      <Layout height="fill">
        <LayoutContent padding={5}>
          <Text>Platter can't reach Docker, so it can't create a server right now.</Text>
        </LayoutContent>
      </Layout>
    );
  }

  const index = await getVersionIndex(result.context.db);
  const releases = index.releases().slice(0, 60);
  const defaultVersion = releases[0]?.version ?? '1.21.4';

  const loadersByVersion = Object.fromEntries(
    releases.map((entry) => [entry.version, availableLoaders(entry.version, index)])
  );

  return (
    <Layout height="fill">
      <LayoutHeader hasDivider>
        <VStack padding={5} gap={0.5}>
          <Heading level={1}>New server</Heading>
          <Text type="supporting">
            Platter picks the Java version, sizes the heap and allocates a port for you.
          </Text>
        </VStack>
      </LayoutHeader>

      <LayoutContent padding={5}>
        <NewServerForm
          versions={releases.map((entry) => ({ version: entry.version, major: entry.major }))}
          defaultVersion={defaultVersion}
          loadersByVersion={loadersByVersion}
          loaderBlurbs={LOADER_BLURB}
        />
      </LayoutContent>
    </Layout>
  );
}
