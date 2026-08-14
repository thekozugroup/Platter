import { useId, useState } from 'react';
import { LIMITS, type ServerAllocation } from '@platter/shared';
import { describeReachability } from '@/components/network/reachability-check';
import { ErrorState } from '@/components/common/error-state';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  useChangeAllocationPort,
  useMediaQuery,
  useReachabilityCheck,
  useServerAllocations,
} from '@/hooks';
import { ApiError, errorMessage } from '@/lib/api-client.js';
import { cn } from '@/lib/utils';

/**
 * Every port this server publishes, what it is for, and whether it answers.
 *
 * Port numbers are the part of self-hosting people are most nervous about, so each row says
 * what the port is *for* in words rather than leaving `rcon` to be looked up. Reachability is
 * per-row and on demand — the probe opens a real socket and waits up to two seconds, so
 * checking three ports on every page load would make the screen feel broken.
 *
 * Under 768px the table becomes cards, rendered instead of the table rather than alongside it,
 * so a screen reader is not read the same data twice.
 */

interface PortPurpose {
  label: string;
  hint: string;
}

/** The port names Platter's blueprints actually declare. Anything else falls back to its name. */
const PURPOSE: Record<string, PortPurpose> = {
  game: {
    label: 'Game',
    hint: 'What players connect to. This is the one that has to be reachable.',
  },
  rcon: {
    label: 'RCON',
    hint: 'Remote console. Platter uses it internally — never forward it to the internet.',
  },
  query: {
    label: 'Query',
    hint: 'Server-list pings: the player count and MOTD shown before joining.',
  },
  voice: {
    label: 'Voice',
    hint: 'Proximity voice chat, if a mod on this server provides it.',
  },
  map: {
    label: 'Map',
    hint: 'A web map served by a mod, opened in a browser rather than the game.',
  },
};

function purposeFor(name: string): PortPurpose {
  return PURPOSE[name] ?? { label: name, hint: 'Declared by this server’s blueprint.' };
}

// ---------------------------------------------------------------------------------------

const TONE_PILL = {
  success: 'border-success/25 bg-success-subtle text-success',
  warning: 'border-warning/25 bg-warning-subtle text-warning',
  danger: 'border-danger/25 bg-danger-subtle text-danger',
  neutral: 'border-pill-border bg-pill text-label-secondary',
} as const;

/**
 * The per-row probe.
 *
 * Its own component so each row can hold its own query without a hook running in a loop, and
 * so an untested row says "not checked" rather than implying anything about the port.
 */
function ReachabilityCell({
  serverId,
  allocation,
}: {
  serverId: string;
  allocation: ServerAllocation;
}) {
  const query = useReachabilityCheck(serverId, allocation.name);
  const verdict = query.data ? describeReachability(query.data) : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {verdict ? (
        <span
          className={cn(
            'inline-flex items-center rounded-pill border px-2 py-0.5 text-caption font-medium',
            TONE_PILL[verdict.tone],
          )}
          title={verdict.body}
        >
          {verdict.headline}
        </span>
      ) : query.isError ? (
        <span
          className={cn(
            'inline-flex items-center rounded-pill border px-2 py-0.5 text-caption font-medium',
            TONE_PILL.danger,
          )}
        >
          Check failed
        </span>
      ) : (
        <span className="text-caption text-label-tertiary">Not checked</span>
      )}

      <Button
        aria-label={`Check whether the ${purposeFor(allocation.name).label.toLowerCase()} port answers`}
        className="h-11 rounded-button px-3 text-caption font-medium"
        isLoading={query.isFetching}
        onClick={() => void query.refetch()}
        size="sm"
        variant="ghost"
      >
        {verdict ? 'Re-check' : 'Check'}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------

export interface PortTableProps {
  serverId: string;
  className?: string;
}

export function PortTable({ serverId, className }: PortTableProps) {
  const query = useServerAllocations(serverId);
  const isWide = useMediaQuery('(min-width: 768px)');
  const [editing, setEditing] = useState<ServerAllocation | null>(null);

  if (query.isPending) {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <span className="sr-only" role="status">
          Loading port allocations.
        </span>
        {[0, 1].map((index) => (
          <Skeleton className="h-16 rounded-md" key={index} />
        ))}
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
        title="Couldn’t read the port allocations"
        variant="inline"
      />
    );
  }

  const allocations = query.data.data;

  if (allocations.length === 0) {
    return (
      <p className={cn('text-subhead text-label-tertiary', className)}>
        No ports are allocated yet. One is assigned when the container is created.
      </p>
    );
  }

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {isWide ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-subhead" scope="col">
                Purpose
              </TableHead>
              <TableHead className="text-subhead" scope="col">
                Port
              </TableHead>
              <TableHead className="text-subhead" scope="col">
                Protocol
              </TableHead>
              <TableHead className="text-subhead" scope="col">
                Reachable
              </TableHead>
              <TableHead className="text-subhead" scope="col">
                <span className="sr-only">Change</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {allocations.map((allocation) => {
              const purpose = purposeFor(allocation.name);
              return (
                <TableRow key={allocation.name}>
                  <TableCell className="whitespace-normal py-3 align-top">
                    <span className="flex flex-col gap-0.5">
                      <span className="text-subhead font-medium text-label">
                        {purpose.label}
                        {allocation.primary ? (
                          <span className="ms-2 rounded-pill border border-pill-border bg-pill px-2 py-0.5 text-caption-2 font-medium text-label-secondary">
                            Primary
                          </span>
                        ) : null}
                      </span>
                      <span className="max-w-xs text-caption text-label-tertiary">
                        {purpose.hint}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="py-3 align-top">
                    <code className="tabular font-mono text-subhead text-label">
                      {allocation.hostPort}
                    </code>
                    {allocation.containerPort !== allocation.hostPort ? (
                      <span className="block text-caption text-label-tertiary">
                        inside the container: {allocation.containerPort}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="py-3 align-top text-subhead uppercase text-label-secondary">
                    {allocation.protocol}
                  </TableCell>
                  <TableCell className="whitespace-normal py-3 align-top">
                    <ReachabilityCell allocation={allocation} serverId={serverId} />
                  </TableCell>
                  <TableCell className="py-3 text-end align-top">
                    <Button
                      className="h-11 rounded-button px-4 text-subhead font-medium"
                      onClick={() => setEditing(allocation)}
                      variant="ghost"
                    >
                      Change
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <ul className="flex flex-col gap-3">
          {allocations.map((allocation) => {
            const purpose = purposeFor(allocation.name);
            return (
              <li
                className="flex flex-col gap-3 rounded-md border border-separator-strong bg-surface p-4"
                key={allocation.name}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="font-sans text-subhead font-semibold text-label">
                      {purpose.label}
                      {allocation.primary ? (
                        <span className="ms-2 rounded-pill border border-pill-border bg-pill px-2 py-0.5 text-caption-2 font-medium text-label-secondary">
                          Primary
                        </span>
                      ) : null}
                    </h4>
                    <p className="mt-0.5 text-caption text-label-tertiary">{purpose.hint}</p>
                  </div>
                  <code className="tabular shrink-0 font-mono text-body text-label">
                    {allocation.hostPort}
                    <span className="text-caption text-label-tertiary">/{allocation.protocol}</span>
                  </code>
                </div>

                <ReachabilityCell allocation={allocation} serverId={serverId} />

                <Button
                  className="h-11 w-full rounded-button text-subhead font-medium"
                  onClick={() => setEditing(allocation)}
                  variant="outline"
                >
                  Change port
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <ChangePortDialog allocation={editing} onClose={() => setEditing(null)} serverId={serverId} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------

function ChangePortDialog({
  serverId,
  allocation,
  onClose,
}: {
  serverId: string;
  allocation: ServerAllocation | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      onOpenChange={(details) => {
        if (!details.open) onClose();
      }}
      open={allocation !== null}
    >
      <DialogContent>
        {/*
          Keyed on the allocation, and only mounted while the dialog is open: the draft port,
          the touched flag and the mutation all reset by unmounting rather than by an effect
          that would have to know which of them to clear.
        */}
        {allocation ? (
          <ChangePortForm allocation={allocation} key={allocation.name} serverId={serverId} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ChangePortForm({
  serverId,
  allocation,
}: {
  serverId: string;
  allocation: ServerAllocation;
}) {
  const change = useChangeAllocationPort(serverId);
  const [value, setValue] = useState(String(allocation.hostPort));
  const [touched, setTouched] = useState(false);
  const helpId = useId();

  const parsed = Number(value);
  const localError =
    value.trim() === ''
      ? 'Enter a port number.'
      : !Number.isInteger(parsed)
        ? 'Ports are whole numbers.'
        : parsed < LIMITS.minPort || parsed > LIMITS.maxPort
          ? `Choose a port between ${LIMITS.minPort} and ${LIMITS.maxPort}. Anything below ${LIMITS.minPort} needs root on the host.`
          : null;

  const serverError =
    change.error instanceof ApiError
      ? (change.error.fieldErrors.hostPort ?? errorMessage(change.error))
      : change.isError
        ? errorMessage(change.error)
        : null;

  const shownError = touched && localError ? localError : serverError;
  const unchanged = parsed === allocation.hostPort;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-sans text-title-3 font-semibold">
          Change the {purposeFor(allocation.name).label.toLowerCase()} port
        </DialogTitle>
        <DialogDescription>
          Platter checks the new port against every other allocation on the node, and against the
          operating system itself.
        </DialogDescription>
      </DialogHeader>

      <DialogBody>
        {change.isSuccess ? (
          /* Monochrome: this reports what happened, not the state of anything. Status
               colour is reserved for status. */
          <Alert variant="info">
            <AlertTitle className="font-sans">
              Port changed to {change.data.allocation.hostPort}
            </AlertTitle>
            <AlertDescription>
              {change.data.requiresRestart
                ? 'The container that is already running keeps its current mapping. Restart the server for the new port to take effect, and tell players the new address.'
                : 'It takes effect the next time this server starts.'}
            </AlertDescription>
          </Alert>
        ) : (
          <form
            className="flex flex-col gap-4"
            id="change-port-form"
            onSubmit={(event) => {
              event.preventDefault();
              setTouched(true);
              if (localError !== null || unchanged) return;
              change.mutate({ portName: allocation.name, hostPort: parsed });
            }}
          >
            <Field invalid={shownError !== null}>
              <FieldLabel>New port</FieldLabel>
              <Input
                aria-describedby={helpId}
                className="h-11"
                inputMode="numeric"
                max={LIMITS.maxPort}
                min={LIMITS.minPort}
                name="hostPort"
                onBlur={() => setTouched(true)}
                onChange={(event) => setValue(event.target.value)}
                type="number"
                value={value}
              />
              {shownError ? (
                <FieldError>{shownError}</FieldError>
              ) : (
                <FieldDescription>
                  Between {LIMITS.minPort} and {LIMITS.maxPort}.
                </FieldDescription>
              )}
            </Field>

            <p className="text-caption text-label-tertiary" id={helpId}>
              Changing this changes the address players type. If you have forwarded a port on your
              router, forward the new one too.
            </p>
          </form>
        )}
      </DialogBody>

      <DialogFooter>
        <DialogClose asChild>
          <Button className="h-11 rounded-button px-5 text-subhead font-medium" variant="outline">
            {change.isSuccess ? 'Done' : 'Cancel'}
          </Button>
        </DialogClose>
        {change.isSuccess ? null : (
          <div className="flex flex-col items-end gap-1">
            <Button
              {...(unchanged ? { 'aria-describedby': `${helpId}-same` } : {})}
              className="h-11 rounded-button px-5 text-subhead font-medium"
              disabled={unchanged}
              form="change-port-form"
              isLoading={change.isPending}
              type="submit"
            >
              Change port
            </Button>
            {unchanged ? (
              <span className="text-caption text-label-tertiary" id={`${helpId}-same`}>
                That is the port it already uses.
              </span>
            ) : null}
          </div>
        )}
      </DialogFooter>
    </>
  );
}
