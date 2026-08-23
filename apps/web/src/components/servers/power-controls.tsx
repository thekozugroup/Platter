import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import {
  ALLOWED_POWER_ACTIONS,
  isTransitional,
  type PowerAction,
  type Server,
  type ServerStatus,
} from '@platter/shared';
import { Close } from 'pixelarticons/react/Close.js';
import { Play } from 'pixelarticons/react/Play.js';
import { Power } from 'pixelarticons/react/Power.js';
import { Reload } from 'pixelarticons/react/Reload.js';
import {
  SERVER_STATUS_HINTS,
  SERVER_STATUS_LABELS,
  StatusPill,
} from '@/components/common/status-pill';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api-client.js';
import { queryKeys } from '@/lib/query.js';
import { cn } from '@/lib/utils';

/**
 * Start / stop / restart / kill.
 *
 * What is legal comes from `ALLOWED_POWER_ACTIONS` in `@platter/shared` — the same table the
 * API enforces — rather than a second copy of the rules that can drift from it. So a button is
 * never offered for a transition the API would refuse, and adding a status to the shared table
 * lights it up here for free.
 *
 * Three rules this component exists to keep:
 *
 * - **No fake optimism.** Pressing Start does not paint the server green. The API answers with
 *   the real `starting`, and that is what shows until the next poll says otherwise.
 * - **A disabled button always says why**, on hover *and* on keyboard focus.
 * - **Kill confirms.** It is SIGKILL: the world is not saved, and a Minecraft world killed
 *   mid-chunk-write can come back corrupt.
 */

type IconComponent = (props: React.SVGProps<SVGSVGElement>) => React.JSX.Element;

interface ActionSpec {
  action: PowerAction;
  label: string;
  icon: IconComponent;
  /** Present tense used while the request is in flight and in the toast. */
  pending: string;
}

const ACTIONS: readonly ActionSpec[] = [
  { action: 'start', label: 'Start', icon: Play, pending: 'Starting' },
  { action: 'stop', label: 'Stop', icon: Power, pending: 'Stopping' },
  { action: 'restart', label: 'Restart', icon: Reload, pending: 'Restarting' },
  { action: 'kill', label: 'Kill', icon: Close, pending: 'Killing' },
];

/**
 * Why an action is not available right now, in the operator's own terms.
 *
 * Returns `null` when the action is legal. Every branch names the real mechanic — the status,
 * the process, the install — rather than "unavailable".
 */
export function powerBlockedReason(status: ServerStatus, action: PowerAction): string | null {
  if (ALLOWED_POWER_ACTIONS[status].includes(action)) return null;

  if (status === 'suspended') {
    return 'An administrator suspended this server. Only an administrator can bring it back.';
  }
  if (status === 'install_failed') {
    // Start *is* the retry — the shared table allows it, and install is idempotent — so this
    // branch is only ever reached by stop/restart/kill, none of which have a process to act on.
    return 'The install did not finish, so nothing is running. Start it to try the install again.';
  }
  if (status === 'deleting') {
    return 'This server is being deleted. Its container and volume are being removed.';
  }
  if (status === 'provisioning') {
    return 'Platter is still creating the container. Power actions become available once it exists.';
  }

  switch (action) {
    case 'start':
      return status === 'installing'
        ? 'It is installing. It starts on its own when the install finishes.'
        : `It is already ${SERVER_STATUS_LABELS[status].toLowerCase()}.`;
    case 'stop':
      return 'There is nothing running to stop.';
    case 'restart':
      return status === 'offline' || status === 'crashed'
        ? 'Restart needs a running server. Start it instead.'
        : `Not while it is ${SERVER_STATUS_LABELS[status].toLowerCase()}. Wait for it to settle.`;
    case 'kill':
      return 'There is no running process to kill.';
    default:
      return SERVER_STATUS_HINTS[status];
  }
}

/**
 * A blocked action.
 *
 * The visible `<Button>` is genuinely `disabled` — it must not be pressable — and a disabled
 * button is out of the tab order, which would put the reason out of a keyboard user's reach.
 * So the wrapper is the control as far as assistive tech is concerned: focusable,
 * `aria-disabled`, and named with the reason. It is also the tooltip's trigger, so hovering and
 * tabbing surface exactly the same sentence.
 */
function BlockedAction({
  label,
  reason,
  children,
}: {
  label: string;
  reason: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-disabled="true"
          aria-label={`${label} — unavailable. ${reason}`}
          className="inline-flex cursor-not-allowed rounded-button"
          role="button"
          tabIndex={0}
        >
          <span aria-hidden="true" className="contents">
            {children}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-pretty">{reason}</TooltipContent>
    </Tooltip>
  );
}

export interface PowerControlsProps {
  /** Anything carrying an id, a name and a status — `Server` or `ServerSummary` both fit. */
  server: { id: string; name: string; status: ServerStatus };
  /** Icon-only buttons for dense rows. Still 44px, still labelled. */
  dense?: boolean;
  /** Renders the live status pill beside the buttons. Use on a page watching one server. */
  showStatus?: boolean;
  /** Hide Kill where the surrounding UI has no room for a confirmation. */
  showKill?: boolean;
  className?: string;
}

export function PowerControls({
  server,
  dense = false,
  showStatus = false,
  showKill = true,
  className,
}: PowerControlsProps) {
  const queryClient = useQueryClient();
  const [confirmingKill, setConfirmingKill] = useState(false);
  const hintId = useId();

  const power = useMutation({
    mutationFn: (action: PowerAction) =>
      api.post<Server>(`/servers/${server.id}/power`, {
        action,
        // `force` skips the graceful stop command. Kill is the only action that means it.
        force: action === 'kill',
      }),
    onSuccess: (updated, action) => {
      // The API's answer carries the real new status. Writing it straight into the cache is
      // honest; guessing `running` from a Start press would not be.
      queryClient.setQueryData(queryKeys.servers.detail(server.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.all });

      toast.create({
        title: `${server.name} is ${SERVER_STATUS_LABELS[updated.status].toLowerCase()}`,
        description:
          action === 'kill'
            ? 'The process was killed. Check the console for an unclean shutdown.'
            : SERVER_STATUS_HINTS[updated.status],
        type: updated.status === 'crashed' ? 'error' : 'info',
      });
    },
    onError: (error: unknown, action) => {
      toast.create({
        title: `Couldn’t ${action} ${server.name}`,
        description: errorMessage(error),
        type: 'error',
      });
    },
  });

  const busy = power.isPending;
  const visible = showKill ? ACTIONS : ACTIONS.filter((spec) => spec.action !== 'kill');

  return (
    <div
      className={cn('flex flex-wrap items-center gap-2', className)}
      {...(showStatus && isTransitional(server.status) ? { 'aria-describedby': hintId } : {})}
    >
      {showStatus ? (
        <div className="flex items-center gap-2 pe-1">
          <StatusPill live size="md" status={server.status} />
          {isTransitional(server.status) ? (
            <span className="text-caption text-label-secondary" id={hintId}>
              {SERVER_STATUS_HINTS[server.status]}
            </span>
          ) : null}
        </div>
      ) : null}

      {visible.map((spec) => {
        const Icon = spec.icon;
        const reason = powerBlockedReason(server.status, spec.action);
        const isThisPending = busy && power.variables === spec.action;
        const destructive = spec.action === 'kill';

        // Kill stays monochrome in the row. Red here is an *action* wearing the colour this
        // system spends only on *state* (DESIGN §2), sitting inches from a red `Crashed` dot
        // that means something else entirely. What Kill costs is said in the confirmation
        // it always opens — that dialog keeps the chroma, on its destructive confirm button.
        const shared = cn(
          'h-11 rounded-button font-medium',
          dense ? 'w-11 px-0' : 'px-4 text-subhead',
        );

        if (reason) {
          return (
            <BlockedAction key={spec.action} label={spec.label} reason={reason}>
              <Button className={shared} disabled size="lg" variant="outline">
                <Icon aria-hidden />
                {dense ? null : spec.label}
              </Button>
            </BlockedAction>
          );
        }

        return (
          <Tooltip key={spec.action}>
            <TooltipTrigger asChild>
              <Button
                {...(dense ? { 'aria-label': `${spec.label} ${server.name}` } : {})}
                className={shared}
                // Loading keeps the button's width — the row must not reflow mid-request.
                isLoading={isThisPending}
                onClick={() => {
                  if (destructive) {
                    setConfirmingKill(true);
                    return;
                  }
                  power.mutate(spec.action);
                }}
                size="lg"
                variant="outline"
              >
                <Icon aria-hidden />
                {dense ? null : spec.label}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {destructive ? 'Kill the process immediately' : `${spec.label} ${server.name}`}
            </TooltipContent>
          </Tooltip>
        );
      })}

      {/*
        Kill is the one power action that can lose data, so it names what it costs rather than
        asking "are you sure". Escape closes it and focus returns to the trigger — Ark's dialog
        handles both.
      */}
      <AlertDialog onOpenChange={({ open }) => setConfirmingKill(open)} open={confirmingKill}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-sans text-title-3 font-semibold">
              Kill {server.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This sends SIGKILL. The game gets no chance to save, so anything since the last
              autosave is lost and a world killed mid-write can come back corrupt. Use Stop unless
              the server is already wedged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody className="text-subhead text-label-secondary">
            Its container stops immediately. Backups and files on the volume are untouched.
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11 rounded-button px-5 text-subhead font-medium">
              Keep it running
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-11 rounded-button px-5 text-subhead font-medium"
              isLoading={busy && power.variables === 'kill'}
              onClick={() => {
                setConfirmingKill(false);
                power.mutate('kill');
              }}
              variant="destructive"
            >
              Kill the process
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
