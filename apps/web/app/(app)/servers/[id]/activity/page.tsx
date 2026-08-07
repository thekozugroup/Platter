import { Heading } from '@astryxdesign/core/Heading';
import { LayoutContent } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { listEvents } from '@platter/core';
import { notFound } from 'next/navigation';
import { ActivityList } from '@/components/activity-list';
import { tryGetContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function ServerActivityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await tryGetContext();
  if (!result.ok) {
    notFound();
  }

  const events = listEvents(result.context.db, { serverId: id, limit: 200 });

  return (
    <LayoutContent padding={5}>
      <VStack gap={4} maxWidth={860}>
        <VStack gap={1}>
          <Heading level={2}>Activity</Heading>
          <Text type="supporting">
            Everything Platter did to this server and why. Anything an AI agent initiated is
            tagged, along with the proposal a human approved.
          </Text>
        </VStack>
        <ActivityList events={events} emptyMessage="Nothing has happened yet." />
      </VStack>
    </LayoutContent>
  );
}
