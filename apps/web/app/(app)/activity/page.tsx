import { Heading } from '@astryxdesign/core/Heading';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { listEvents, listServers } from '@platter/core';
import type { Metadata } from 'next';
import { ActivityList } from '@/components/activity-list';
import { tryGetContext } from '@/lib/server';

export const metadata: Metadata = { title: 'Activity' };
export const dynamic = 'force-dynamic';

export default async function ActivityPage() {
  const result = await tryGetContext();

  if (!result.ok) {
    return (
      <Layout height="fill">
        <LayoutContent padding={5}>
          <Text>Platter can't reach Docker.</Text>
        </LayoutContent>
      </Layout>
    );
  }

  const events = listEvents(result.context.db, { limit: 300 });
  const names = new Map(listServers(result.context.db, { includeDeleted: true }).map((s) => [s.id, s.name]));

  return (
    <Layout height="fill">
      <LayoutHeader hasDivider>
        <VStack padding={5} gap={0.5}>
          <Heading level={1}>Activity</Heading>
          <Text type="supporting">
            Everything that has happened across every server, newest first.
          </Text>
        </VStack>
      </LayoutHeader>
      <LayoutContent padding={5}>
        <VStack maxWidth={900}>
          <ActivityList
            events={events.map((event) => ({
              ...event,
              message: event.serverId
                ? `${names.get(event.serverId) ?? 'Unknown server'} · ${event.message}`
                : event.message,
            }))}
            emptyMessage="Nothing has happened yet. Create a server to get started."
          />
        </VStack>
      </LayoutContent>
    </Layout>
  );
}
