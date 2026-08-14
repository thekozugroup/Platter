import { useState } from 'react';
import { formatAddress, type ServerAllocation } from '@platter/shared';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import type { ReachabilityResult } from '@/hooks';
import { useReachabilityCheck } from '@/hooks';
import { errorMessage } from '@/lib/api-client.js';
import { cn } from '@/lib/utils';

/**
 * "Can anyone actually connect?" — answered honestly.
 *
 * The strongest thing this check can ever establish is that the port answers *from where the
 * API runs*, which is inside the same network. Proving the internet can reach it needs a
 * vantage point outside the LAN, and Platter does not have one (see `apps/api/src/net/probe.ts`).
 * So "reachable on your local network but not necessarily from the internet" is the honest
 * ceiling, and this panel says exactly that instead of a green tick that means less than it
 * looks like it means.
 *
 * A successful local *bind* test alone is never reported as reachable: the bind only proves
 * something is holding the port, not that it answers. Only `reachability: 'lan'`, which
 * requires a real connection, reads as success.
 */

export type ReachabilityTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface ReachabilityVerdict {
  tone: ReachabilityTone;
  headline: string;
  /** What the probe established, in plain words. */
  body: string;
  /** The next thing to try. Null when there is nothing to do. */
  advice: string | null;
}

/** Shared with the port table so one probe never gets two different readings. */
export function describeReachability(result: ReachabilityResult): ReachabilityVerdict {
  const address = formatAddress(result.host, result.port);

  if (result.reachability === 'lan') {
    return {
      tone: 'success',
      headline: 'Reachable on your local network',
      body: `Something answered on ${address} in ${result.latencyMs} ms. ${result.detail}`,
      advice:
        'This does not prove the internet can reach it. Platter probes from inside your own network, so it can only ever confirm the local side. If players outside your home cannot join, the port still needs forwarding on your router.',
    };
  }

  if (result.reachability === 'unreachable') {
    if (result.listening === false) {
      return {
        tone: 'danger',
        headline: 'Nothing is listening on this port',
        body: `${result.detail} The port is free on the node, which means the container is not bound to it.`,
        advice:
          'Start the server. If it is already running, read the console for a bind error — another process may be holding the port, or the container may have exited during boot.',
      };
    }
    return {
      tone: 'danger',
      headline: 'Nothing answered',
      body: `${address} did not accept a connection. ${result.detail}`,
      advice:
        'Check the server is running, then check the node’s own firewall allows this port. If the node is on another machine, its network has to let this one reach it.',
    };
  }

  return {
    tone: 'warning',
    headline: 'Couldn’t tell',
    body: `${result.detail} ${
      result.protocol === 'udp'
        ? 'UDP has no handshake, so silence looks identical for a healthy server and a dead one.'
        : ''
    }`.trim(),
    advice:
      'This is not evidence either way. The reliable test is someone actually connecting — or watching the console for their join line.',
  };
}

const TONE_CLASS: Record<ReachabilityTone, string> = {
  success: 'border-success/25 bg-success-subtle',
  warning: 'border-warning/25 bg-warning-subtle',
  danger: 'border-danger/25 bg-danger-subtle',
  neutral: 'border-separator-strong bg-bg-sunken',
};

const TONE_TEXT: Record<ReachabilityTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  neutral: 'text-label',
};

export interface ReachabilityCheckProps {
  serverId: string;
  allocations: readonly ServerAllocation[];
  className?: string;
}

export function ReachabilityCheck({ serverId, allocations, className }: ReachabilityCheckProps) {
  const primary = allocations.find((allocation) => allocation.primary) ?? allocations[0];
  const [portName, setPortName] = useState(primary?.name ?? '');
  const query = useReachabilityCheck(serverId, portName === '' ? undefined : portName);

  const result = query.data;
  const verdict = result ? describeReachability(result) : null;
  const selected = allocations.find((allocation) => allocation.name === portName) ?? primary;

  if (allocations.length === 0) {
    return (
      <p className={cn('text-subhead text-label-tertiary', className)}>
        This server has no allocated ports yet, so there is nothing to test. One is assigned when
        the container is created.
      </p>
    );
  }

  return (
    <div className={cn('flex flex-col gap-5', className)}>
      <div className="flex flex-wrap items-end gap-3">
        {allocations.length > 1 ? (
          <Field className="w-auto">
            <FieldLabel>Port to test</FieldLabel>
            <NativeSelect
              className="[&>select]:h-11"
              name="portName"
              onChange={(event) => setPortName(event.target.value)}
              value={portName}
            >
              {allocations.map((allocation) => (
                <NativeSelectOption key={allocation.name} value={allocation.name}>
                  {allocation.name} — {allocation.hostPort}/{allocation.protocol}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        ) : null}

        <Button
          className="h-11 rounded-button px-5 text-subhead font-medium"
          isLoading={query.isFetching}
          onClick={() => void query.refetch()}
          variant="outline"
        >
          {result ? 'Check again' : 'Run the check'}
        </Button>
      </div>

      <div aria-live="polite" role="status">
        {query.isFetching ? (
          <p className="text-subhead text-label-secondary">
            Opening a connection to the port. This waits up to two seconds.
          </p>
        ) : query.isError ? (
          <div className={cn('rounded-md border p-4', TONE_CLASS.danger)}>
            <h4 className={cn('font-sans text-subhead font-semibold', TONE_TEXT.danger)}>
              The check could not run
            </h4>
            <p className="mt-1 text-subhead text-label-secondary">{errorMessage(query.error)}</p>
          </div>
        ) : result && verdict ? (
          <div
            className={cn('flex flex-col gap-2 rounded-md border p-4', TONE_CLASS[verdict.tone])}
          >
            <h4 className={cn('font-sans text-subhead font-semibold', TONE_TEXT[verdict.tone])}>
              {verdict.headline}
            </h4>
            <p className="text-subhead leading-normal text-label-secondary">{verdict.body}</p>
            {verdict.advice ? (
              <p className="text-subhead leading-normal text-label-secondary">{verdict.advice}</p>
            ) : null}

            <p className="text-caption text-label-tertiary">
              {result.listening === null
                ? 'This server is on a remote node, so Platter could not test whether anything is bound locally — only whether the port answers.'
                : result.listening
                  ? 'Something is bound to the port on the node.'
                  : 'Nothing is bound to the port on the node.'}{' '}
              Checked{' '}
              <time dateTime={result.checkedAt} title={new Date(result.checkedAt).toLocaleString()}>
                {new Date(result.checkedAt).toLocaleTimeString()}
              </time>
              .
            </p>
          </div>
        ) : (
          <p className="text-subhead text-label-secondary">
            Nothing has been tested yet. The check opens a real connection to the port from the
            machine running Platter.
          </p>
        )}
      </div>

      {/*
        Always visible, not hidden behind a failure: port forwarding is where most self-hosters
        get stuck, and a green result on the LAN is exactly when someone wrongly concludes they
        are done.
      */}
      <section className="flex flex-col gap-2 rounded-md border border-separator-strong bg-bg-sunken p-4">
        <h4 className="font-sans text-subhead font-semibold text-label">
          Getting players in from outside your network
        </h4>
        <ol className="ms-5 flex list-decimal flex-col gap-1.5 text-subhead leading-normal text-label-secondary">
          <li>
            In your router, forward external port{' '}
            <code className="font-mono">{selected?.hostPort ?? '—'}</code> (
            {selected?.protocol ?? 'tcp'}) to{' '}
            {result === undefined ? (
              // An allocation binds 0.0.0.0, which is not an address anybody can forward to.
              // The probe is what reports the node's real address, so before it has run this
              // says so rather than printing a wildcard.
              <>the machine running this server, on the same port</>
            ) : (
              <code className="font-mono">
                {result.host}:{selected?.hostPort ?? result.port}
              </code>
            )}
            .
          </li>
          <li>
            Allow the same port through the firewall on the machine running the container. A fresh
            Linux install usually blocks it.
          </li>
          <li>
            Check that the WAN address your router shows matches what a “what is my IP” page says.
            If they differ, your ISP is using CGNAT and no amount of port forwarding will work — you
            need a static IP, IPv6, or a tunnel.
          </li>
        </ol>
        <p className="text-caption text-label-tertiary">
          Platter cannot verify any of this from here, which is why it never claims a port is
          reachable from the internet.
        </p>
      </section>
    </div>
  );
}
