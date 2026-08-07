import { LayoutContent } from '@astryxdesign/core/Layout';
import { getServer } from '@platter/core';
import { notFound } from 'next/navigation';
import { Console } from '@/components/console';
import { DockerUnavailable } from '@/components/docker-unavailable';
import { tryGetContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function ConsolePage({ params }: { params: Promise<{ id: string }> }) {
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
      <Console serverId={server.id} status={server.status} />
    </LayoutContent>
  );
}
