import { Heading } from '@astryxdesign/core/Heading';
import { LayoutContent } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { getServer, listBackups } from '@platter/core';
import { notFound } from 'next/navigation';
import { BackupsPanel } from '@/components/backups-panel';
import { DockerUnavailable } from '@/components/docker-unavailable';
import { tryGetContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function BackupsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await tryGetContext();
  if (!result.ok) {
    return <DockerUnavailable message={result.error.message} />;
  }

  const server = getServer(result.context.db, id);
  if (!server) {
    notFound();
  }

  const backups = listBackups(result.context, id);

  return (
    <LayoutContent padding={5}>
      <VStack gap={4} maxWidth={860}>
        <VStack gap={1}>
          <Heading level={2}>Backups</Heading>
          <Text type="supporting">
            Platter can back up a running server without kicking anyone off: it pauses auto-save,
            flushes every loaded chunk to disk, archives, then resumes. Restoring always takes a
            safety copy first.
          </Text>
        </VStack>

        <BackupsPanel
          serverId={server.id}
          serverStatus={server.status}
          retention={server.backupRetention}
          schedule={server.backupCron}
          backups={backups.map((backup) => ({
            id: backup.id,
            label: backup.label,
            status: backup.status,
            statusMessage: backup.statusMessage,
            sizeBytes: backup.sizeBytes,
            hotBackup: backup.hotBackup,
            trigger: backup.trigger,
            createdAt: backup.createdAt,
          }))}
        />
      </VStack>
    </LayoutContent>
  );
}
