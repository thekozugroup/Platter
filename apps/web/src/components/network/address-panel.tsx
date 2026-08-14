import { formatAddress } from '@platter/shared';
import { CopyField } from '@/components/common/copy-field';
import { ErrorState } from '@/components/common/error-state';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import type { ServerAddress } from '@/hooks';
import { useServerAddress } from '@/hooks';
import { cn } from '@/lib/utils';

/**
 * How a player connects. This is the headline of the whole Network screen.
 *
 * Platter's friendly addressing is the feature that makes self-hosting feel easy, so the
 * address gets real presence: one big monospace string, copyable, with a plain sentence saying
 * why it is short. The fallbacks stay visible underneath rather than hidden behind a
 * disclosure, because the shortest form only works when the network cooperates and the person
 * troubleshooting at 11pm needs the raw `ip:port` without hunting for it.
 *
 * `connectString` is computed by the API (`apps/api/src/net/zone.ts`) and is already the
 * shortest thing that actually works — a bare hostname only when an SRV record covers the
 * port, `host:port` when the name resolves but nothing advertises the port, and `ip:port` when
 * the name would not resolve at all. This panel never shortens it further on its own.
 */

/** Why the headline address is the length it is, in one sentence. */
function explainAddress(address: ServerAddress): string {
  if (address.srv !== null) {
    return `No port needed. An SRV record points ${address.srv.service}._${address.srv.protocol}.${address.fqdn} at port ${address.srv.port}, and the Minecraft client follows it automatically.`;
  }
  if (address.connectString === formatAddress(address.ip, address.port)) {
    return `The hostname ${address.fqdn} is not resolving right now, so this is the raw address. It always works from a machine that can reach the node.`;
  }
  return `The port has to be typed too — nothing on this network advertises which port to use for ${address.fqdn}.`;
}

export interface AddressPanelProps {
  serverId: string;
  serverName: string;
  className?: string;
}

export function AddressPanel({ serverId, serverName, className }: AddressPanelProps) {
  const query = useServerAddress(serverId);

  if (query.isPending) {
    return (
      <div className={cn('flex flex-col gap-4', className)}>
        <span className="sr-only" role="status">
          Loading this server’s address.
        </span>
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-14 w-full max-w-md rounded-md" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <ErrorState
        className={className}
        error={query.error}
        isRetrying={query.isFetching}
        onRetry={() => void query.refetch()}
        title="Couldn’t work out this server’s address"
        variant="inline"
      />
    );
  }

  const address = query.data;
  const hostPort = formatAddress(address.fqdn, address.port);
  const ipPort = formatAddress(address.ip, address.port);
  const isMdnsZone = address.zone.endsWith('.local');

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <div className="flex flex-col gap-3">
        {/* Sentence case, matching the <dt>s eight lines below at the same size and role.
            DESIGN §11 is sentence case everywhere; an all-caps eyebrow here split the
            casing inside one panel. */}
        <p className="text-caption font-medium text-label-tertiary">Players type this</p>

        {/*
          The headline reuses CopyField rather than growing a second copy button: the
          clipboard failure path (permissions, a cross-origin frame, plain http:// on a LAN)
          is real and is already solved there. Only the type scale is overridden.
        */}
        <CopyField
          className={cn(
            'max-w-full',
            '[&_code]:text-label [&_code]:text-title-3 [&_code]:font-medium sm:[&_code]:text-title-2',
            '[&>div]:py-3',
          )}
          label="Connect address"
          value={address.connectString}
        />

        <p className="max-w-prose text-subhead leading-normal text-label-secondary">
          {explainAddress(address)}
        </p>
      </div>

      <dl className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <dt className="text-caption font-medium text-label-tertiary">Hostname and port</dt>
          <dd>
            <CopyField label="Hostname and port" value={hostPort} />
          </dd>
        </div>
        <div className="flex flex-col gap-1.5">
          <dt className="text-caption font-medium text-label-tertiary">IP address and port</dt>
          <dd>
            <CopyField label="IP address and port" value={ipPort} />
          </dd>
        </div>
      </dl>

      {isMdnsZone ? (
        address.mdnsAvailable ? (
          /* Not `success`: green in this system means a *running* server and nothing else
             (DESIGN §2). A green panel under a green Running dot that meant something
             different was the clearest way to teach a reader that the colour is
             decorative. `info` is monochrome. */
          <Alert variant="info">
            <AlertTitle className="font-sans">Advertised on this network</AlertTitle>
            <AlertDescription>
              <code className="font-mono">{address.fqdn}</code> is being announced over mDNS, so
              anything on the same network resolves it with no DNS setup at all. It does not leave
              the local network — anyone connecting from outside needs the IP address, or a real
              domain.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="warning">
            <AlertTitle className="font-sans">
              The <code className="font-mono">.local</code> name is not being announced
            </AlertTitle>
            <AlertDescription>
              {serverName} is not currently advertised over mDNS — the responder announces a server
              only while it is running, and some networks block multicast entirely. Give players{' '}
              <code className="font-mono">{ipPort}</code> until it comes back.
            </AlertDescription>
          </Alert>
        )
      ) : (
        <Alert>
          <AlertTitle className="font-sans">
            Using the <code className="font-mono">{address.zone}</code> zone
          </AlertTitle>
          <AlertDescription>
            This name resolves through your own DNS rather than mDNS, so it works from anywhere the
            records are published. The records to paste are further down this page.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
