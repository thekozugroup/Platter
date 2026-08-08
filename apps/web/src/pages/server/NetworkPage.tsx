import { AddressPanel } from '@/components/network/address-panel';
import { PortTable } from '@/components/network/port-table';
import { ReachabilityCheck } from '@/components/network/reachability-check';
import { CopyField } from '@/components/common/copy-field';
import { ErrorState } from '@/components/common/error-state';
import { PageBody } from '@/components/layout/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useZoneRecords } from '@/hooks';
import { useAuth } from '@/lib/auth.js';
import { useServerScope } from '@/pages/server/ServerLayout';

/**
 * Addressing, ports and whether any of it actually works.
 *
 * The order is the order a person cares about: what players type, then what is published, then
 * proof. DNS records come last and only for an administrator — a zone spans every server on
 * this Platter, so it is infrastructure rather than a per-server setting.
 */

export function NetworkPage() {
  const { server } = useServerScope();
  const { isAdmin } = useAuth();

  return (
    <PageBody>
      <div className="flex flex-col gap-16 sm:gap-24">
        <section aria-labelledby="network-address">
          <h2 className="sr-only" id="network-address">
            Connect address
          </h2>
          <AddressPanel serverId={server.id} serverName={server.name} />
        </section>

        <section aria-labelledby="network-ports" className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <h2 className="text-title-2 text-label" id="network-ports">
              Ports
            </h2>
            <p className="max-w-prose text-subhead text-label-secondary">
              Each port is published from the node to the container. Changing one takes effect
              on the next start.
            </p>
          </div>
          <PortTable serverId={server.id} />
        </section>

        <section aria-labelledby="network-reachability" className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <h2 className="text-title-2 text-label" id="network-reachability">
              Can anyone connect?
            </h2>
            <p className="max-w-prose text-subhead text-label-secondary">
              Platter opens a real connection to the port from the machine it runs on. That
              proves the local side and nothing more.
            </p>
          </div>
          <ReachabilityCheck allocations={server.allocations} serverId={server.id} />
        </section>

        {isAdmin ? <ZoneRecords /> : null}
      </div>
    </PageBody>
  );
}

// ---------------------------------------------------------------------------------------

/**
 * The records to paste at a DNS provider.
 *
 * Only meaningful once the zone has been moved off `platter.local`, which resolves over mDNS
 * on its own and needs nothing published anywhere. Read-only here: the zone is set once, for
 * the whole install, in administrator settings.
 */
function ZoneRecords() {
  const query = useZoneRecords();

  if (query.isPending) {
    return (
      <section className="flex flex-col gap-5">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-32 w-full rounded-md" />
      </section>
    );
  }

  if (query.isError) {
    return (
      <section aria-labelledby="network-dns" className="flex flex-col gap-5">
        <h2 className="text-title-2 text-label" id="network-dns">
          DNS records
        </h2>
        <ErrorState
          error={query.error}
          isRetrying={query.isFetching}
          onRetry={() => void query.refetch()}
          title="Couldn’t read the zone"
          variant="inline"
        />
      </section>
    );
  }

  const zone = query.data;
  const isDefaultZone = zone.zone.endsWith('.local');

  return (
    <section aria-labelledby="network-dns" className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 className="text-title-2 text-label" id="network-dns">
          DNS records
        </h2>
        <p className="max-w-prose text-subhead text-label-secondary">
          Paste these at your DNS provider so the hostnames resolve from anywhere, not only on
          this network.
        </p>
      </div>

      {isDefaultZone ? (
        <Alert>
          <AlertTitle className="font-sans">
            Nothing to publish for <code className="font-mono">{zone.zone}</code>
          </AlertTitle>
          <AlertDescription>
            A <code className="font-mono">.local</code> zone resolves over mDNS on the local
            network and is not something a DNS provider will host. Point Platter at a real
            domain in administrator settings, and the records to publish appear here.
          </AlertDescription>
        </Alert>
      ) : null}

      {zone.publicIp === null ? (
        <Alert variant="warning">
          <AlertTitle className="font-sans">No public IP is set</AlertTitle>
          <AlertDescription>
            The wildcard record below points at a placeholder. Set the public IP in
            administrator settings, or edit the address by hand before publishing it.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <h3 className="font-sans text-subhead font-semibold text-label">
            Wildcard A record
          </h3>
          <p className="text-caption text-label-tertiary">
            One record covers every server: <code className="font-mono">{zone.wildcardA.name}</code>{' '}
            → <code className="font-mono">{zone.wildcardA.target}</code>, TTL{' '}
            <span className="tabular">{zone.wildcardA.ttl}</span>.
          </p>
          <CopyField label="Wildcard A record" value={zone.wildcardA.line} />
        </div>

        {zone.srvRecords.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <h3 className="font-sans text-subhead font-semibold text-label">SRV records</h3>
            <p className="text-caption text-label-tertiary">
              These are what let a player type the hostname with no port. One per Minecraft:
              Java server.
            </p>
            <ul className="flex flex-col gap-2">
              {zone.srvRecords.map((record) => (
                <li key={record.name}>
                  <CopyField label={`SRV record for ${record.name}`} value={record.line} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <h3 className="font-sans text-subhead font-semibold text-label">
            The whole zone file
          </h3>
          <p className="text-caption text-label-tertiary">
            For a provider that accepts a BIND-style import rather than one record at a time.
          </p>
          <pre className="max-h-64 overflow-auto rounded-md border border-separator-strong bg-bg-sunken p-3 font-mono text-caption text-label-secondary">
            <code>{zone.zoneFileText}</code>
          </pre>
          <CopyField
            className="max-w-md"
            display="Copy the full zone file"
            label="Zone file"
            value={zone.zoneFileText}
          />
        </div>
      </div>
    </section>
  );
}
