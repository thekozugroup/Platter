import { LayoutContent } from '@astryxdesign/core/Layout';
import { getServer } from '@platter/core';
import { notFound } from 'next/navigation';
import { DockerUnavailable } from '@/components/docker-unavailable';
import { SettingsForm } from '@/components/settings-form';
import { tryGetContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await tryGetContext();
  if (!result.ok) {
    return <DockerUnavailable message={result.error.message} />;
  }

  const server = getServer(result.context.db, id);
  if (!server) {
    notFound();
  }

  return (
    <LayoutContent padding={5}>
      <SettingsForm
        serverId={server.id}
        status={server.status}
        settings={server.settings}
        memoryMiB={server.memoryMiB}
        cpus={server.cpus}
        rconPort={server.rconPort}
        rconPassword={server.rconPassword}
        dataDir={server.dataDir}
      />
    </LayoutContent>
  );
}
