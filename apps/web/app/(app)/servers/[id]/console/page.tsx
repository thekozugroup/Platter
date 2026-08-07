import { LayoutContent } from '@astryxdesign/core/Layout';
import { getServer } from '@platter/core';
import { notFound } from 'next/navigation';
import { Console } from '@/components/console';
import { tryGetContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function ConsolePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await tryGetContext();
  if (!result.ok) {
    notFound();
  }

  const server = getServer(result.context.db, id);
  if (!server) {
    notFound();
  }

  // The console owns the full height of the content region — it is the one view where more
  // visible lines is straightforwardly better.
  return (
    <LayoutContent padding={5} isScrollable={false}>
      <Console serverId={server.id} status={server.status} />
    </LayoutContent>
  );
}
